import { Bot, InlineKeyboard } from "grammy";
import type { ReactionType } from "grammy/types";
import { config } from "../config.js";
import { sendMessage, cancelChat } from "../session/manager.js";
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
  handleCancelJob,
  handleRunJob,
  handleTimezone,
} from "./commands.js";
import type { SchedulerService } from "../scheduler/service.js";
import { processInbox } from "../scheduler/inbox.js";
import { createOnboardingComposer, handleOnboardingText } from "./ui/onboarding.js";
import { createJobsComposer } from "./ui/jobs-ui.js";
import { createMemoryComposer } from "./ui/memory-ui.js";
import { createIdentityComposer } from "./ui/identity-ui.js";
import {
  trackMessage,
  trackMessageIds,
  getTracked,
  writeFeedback,
  getReactBackEmoji,
} from "./feedback.js";

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

  // Inline stop button handler
  bot.callbackQuery(/^stop:/, async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const killed = await cancelChat(chatId);
    await ctx.answerCallbackQuery({
      text: killed ? "Cancelled." : "Already finished.",
    });
  });

  // Register commands
  bot.command("start", handleStart);
  bot.command("new", handleNew);
  bot.command("cancel", handleCancel);
  bot.command("status", handleStatus);

  // Scheduler commands (require scheduler to be set) — text-only commands stay here
  if (opts.scheduler) {
    bot.command("schedule", handleSchedule(opts.scheduler));
    bot.command("every", handleEvery(opts.scheduler));
    bot.command("canceljob", handleCancelJob(opts.scheduler));
    bot.command("runjob", handleRunJob(opts.scheduler));
    bot.command("timezone", handleTimezone(opts.scheduler));
  }

  // UI Composers — after access control, before text handler
  bot.use(createOnboardingComposer());
  bot.use(createIdentityComposer());
  bot.use(createMemoryComposer());
  if (opts.scheduler) {
    bot.use(createJobsComposer(opts.scheduler));
  }

  // Text message handler — forward to Claude Code
  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;

    // Skip if it looks like a command we didn't handle
    if (text.startsWith("/")) return;

    // Intercept text during onboarding wizard
    if (await handleOnboardingText(ctx)) return;

    // Sanitize and check for injection
    const sanitized = sanitizeForPrompt(text);
    checkAndLogInjection(sanitized, `telegram:${chatId}`);

    // Create streaming handler with inline stop button
    const stopButton = new InlineKeyboard().text("Stop", `stop:${chatId}`);
    const stream = createTelegramStream({
      api: bot.api,
      chatId,
      replyToMessageId: ctx.message.message_id,
      replyMarkup: { inline_keyboard: stopButton.inline_keyboard },
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
          await bot.api.editMessageText(chatId, streamMsgId, fullText, {
            reply_markup: { inline_keyboard: [] },
          });
        } catch {
          // Edit may fail if text is identical; that's fine
        }
        trackMessage(chatId, streamMsgId, { text: fullText, prompt: sanitized });
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
      const sentIds: number[] = [];
      for (const chunk of chunks) {
        const sent = await ctx.reply(chunk);
        sentIds.push(sent.message_id);
      }
      trackMessageIds(chatId, sentIds, { text: fullText, prompt: sanitized });
    } catch (err) {
      await stream.clear();
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Error: ${msg}`);
    } finally {
      if (opts.scheduler) {
        await processInbox(chatId, config.workspaceDir, opts.scheduler, bot.api)
          .catch(err => console.warn("[inbox] Failed:", err));
      }
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

  // Handle emoji reactions — feedback loop for growth
  bot.on("message_reaction", async (ctx) => {
    const mr = ctx.messageReaction;
    if (!mr) return;

    const { emojiAdded } = ctx.reactions();
    if (emojiAdded.length === 0) return;

    const chatId = mr.chat.id;
    const messageId = mr.message_id;
    const emoji = emojiAdded[0];

    // Look up what we said
    const tracked = getTracked(chatId, messageId);

    // Write to daily log
    await writeFeedback({
      emoji,
      snippet: tracked?.text ?? "(earlier response)",
      context: tracked?.prompt ?? "",
      timestamp: new Date(),
    }).catch((err) => {
      console.warn("[feedback] Failed to write feedback:", err);
    });

    // React back (if appropriate)
    const reactEmoji = await getReactBackEmoji(emoji);
    if (reactEmoji) {
      await ctx.api
        .setMessageReaction(chatId, messageId, [
          { type: "emoji", emoji: reactEmoji } as ReactionType,
        ])
        .catch(() => {});
    }
  });

  return bot;
}
