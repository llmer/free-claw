import { Bot } from "grammy";
import { config, type Config } from "../config.js";
import { sendMessage } from "../session/manager.js";
import { sanitizeForPrompt } from "../security/sanitize.js";
import { checkAndLogInjection } from "../security/detect-injection.js";
import { createTelegramStream, chunkText } from "./streaming.js";
import {
  handleStart,
  handleNew,
  handleCancel,
  handleStatus,
  handleSchedule,
  handleEvery,
  handleJobs,
  handleCancelJob,
  handleRunJob,
  handleTimezone,
} from "./commands.js";
import type { SchedulerService } from "../scheduler/service.js";

export function createBot(opts: {
  mcpConfigPath?: string;
  scheduler?: SchedulerService;
}): Bot {
  const bot = new Bot(config.telegramBotToken);

  // Access control middleware
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    if (config.allowedUsers.length > 0 && !config.allowedUsers.includes(userId)) {
      console.warn(`[access] Unauthorized user: ${userId} (${ctx.from?.username ?? "unknown"})`);
      await ctx.reply("Unauthorized. Your user ID is not in the allowed list.");
      return;
    }

    await next();
  });

  // Register commands
  bot.command("start", handleStart);
  bot.command("new", handleNew);
  bot.command("cancel", handleCancel);
  bot.command("status", handleStatus);

  // Scheduler commands (require scheduler to be set)
  if (opts.scheduler) {
    bot.command("schedule", handleSchedule(opts.scheduler));
    bot.command("every", handleEvery(opts.scheduler));
    bot.command("jobs", handleJobs(opts.scheduler));
    bot.command("canceljob", handleCancelJob(opts.scheduler));
    bot.command("runjob", handleRunJob(opts.scheduler));
    bot.command("timezone", handleTimezone(opts.scheduler));
  }

  // Text message handler — forward to Claude Code
  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;

    // Skip if it looks like a command we didn't handle
    if (text.startsWith("/")) return;

    // Sanitize and check for injection
    const sanitized = sanitizeForPrompt(text);
    checkAndLogInjection(sanitized, `telegram:${chatId}`);

    // Create streaming handler
    const stream = createTelegramStream({
      api: bot.api,
      chatId,
      replyToMessageId: ctx.message.message_id,
    });

    try {
      const result = await sendMessage({
        chatId,
        prompt: sanitized,
        mcpConfigPath: opts.mcpConfigPath,
        onText: (accumulatedText) => {
          stream.update(accumulatedText);
        },
      });

      // Stop streaming (final flush)
      await stream.stop();

      // Send the full response as chunked messages.
      // If the stream message already contains most of the text, we skip re-sending.
      const streamMsgId = stream.messageId();
      let fullText = result.text.trim();

      // Surface CLI errors so the user knows what went wrong
      if (result.error && fullText === "(no output)") {
        fullText = `⚠ ${result.error}`;
      }

      if (!fullText) {
        if (!streamMsgId) {
          await ctx.reply("(no response)");
        }
        return;
      }

      // If the full response fits in one message and we have a stream message,
      // do a final edit to ensure completeness.
      if (fullText.length <= 4096 && streamMsgId) {
        try {
          await bot.api.editMessageText(chatId, streamMsgId, fullText);
        } catch {
          // Edit may fail if text is identical; that's fine
        }
        return;
      }

      // For long responses, delete the stream preview and send chunked messages
      if (streamMsgId) {
        try {
          await bot.api.deleteMessage(chatId, streamMsgId);
        } catch {
          // best-effort
        }
      }

      const chunks = chunkText(fullText);
      for (const chunk of chunks) {
        await ctx.reply(chunk);
      }
    } catch (err) {
      await stream.clear();
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Error: ${msg}`);
    }
  });

  // Handle photo messages (forward caption or description request)
  bot.on("message:photo", async (ctx) => {
    const chatId = ctx.chat.id;
    const caption = ctx.message.caption ?? "Describe this image";
    const sanitized = sanitizeForPrompt(caption);

    try {
      const result = await sendMessage({
        chatId,
        prompt: sanitized,
        mcpConfigPath: opts.mcpConfigPath,
      });

      const chunks = chunkText(result.text.trim() || "(no response)");
      for (const chunk of chunks) {
        await ctx.reply(chunk);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Error: ${msg}`);
    }
  });

  return bot;
}
