import { Bot, InlineKeyboard } from "grammy";
import type { ReactionType } from "grammy/types";
import { config } from "../config.js";
import { sendMessage, cancelChat } from "../session/manager.js";
import { sanitizeForPrompt } from "../security/sanitize.js";
import { checkAndLogInjection } from "../security/detect-injection.js";
import { createTelegramStream, chunkText } from "./streaming.js";
import { markdownToTelegramHtml, isTelegramParseError } from "./format.js";
import { downloadTelegramPhoto } from "./image.js";
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

/** Deliver a Claude result: final-edit the stream message or send chunked messages. */
async function deliverResult(
  result: { text: string; error?: string },
  stream: ReturnType<typeof createTelegramStream>,
  ctx: { reply: (text: string) => Promise<{ message_id: number }> },
  botApi: Bot["api"],
  chatId: number,
  prompt: string,
): Promise<void> {
  await stream.stop();

  const streamMsgId = stream.messageId();
  let fullText = result.text.trim();

  if (result.error && fullText === "(no output)") {
    fullText = `⚠ ${result.error}`;
  }

  if (!fullText) {
    if (!streamMsgId) {
      await ctx.reply("(no response)");
    }
    return;
  }

  if (fullText.length <= 4096 && streamMsgId) {
    try {
      const html = markdownToTelegramHtml(fullText);
      await botApi.editMessageText(chatId, streamMsgId, html, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] },
      });
    } catch (err) {
      // Fallback to plain text on parse error
      if (isTelegramParseError(err)) {
        try {
          await botApi.editMessageText(chatId, streamMsgId, fullText, {
            reply_markup: { inline_keyboard: [] },
          });
        } catch {
          // Edit may fail if text is identical; that's fine
        }
      }
      // else: Edit may fail if text is identical; that's fine
    }
    trackMessage(chatId, streamMsgId, { text: fullText, prompt });
    return;
  }

  if (streamMsgId) {
    try {
      await botApi.deleteMessage(chatId, streamMsgId);
    } catch {
      // best-effort
    }
  }

  const chunks = chunkText(fullText);
  const sentIds: number[] = [];
  for (const chunk of chunks) {
    let sent: { message_id: number };
    try {
      const html = markdownToTelegramHtml(chunk);
      sent = await botApi.sendMessage(chatId, html, { parse_mode: "HTML" });
    } catch {
      sent = await ctx.reply(chunk);
    }
    sentIds.push(sent.message_id);
  }
  trackMessageIds(chatId, sentIds, { text: fullText, prompt });
}

export function createBot(opts: {
  mcpConfigPath?: string;
  scheduler?: SchedulerService;
}): Bot {
  const bot = new Bot(config.telegramBotToken);

  bot.catch((err) => {
    console.error("[bot] Unhandled error in middleware:", err.error);
  });

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
    try {
      await ctx.answerCallbackQuery({
        text: killed ? "Cancelled." : "Already finished.",
      });
    } catch {
      // Callback query may have expired (~30s Telegram timeout) — ignore
    }
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

    // Create streaming handler with inline stop button and immediate placeholder
    const stopButton = new InlineKeyboard().text("Stop", `stop:${chatId}`);
    const stream = createTelegramStream({
      api: bot.api,
      chatId,
      replyToMessageId: ctx.message.message_id,
      replyMarkup: { inline_keyboard: stopButton.inline_keyboard },
      initialText: "⏳ Working...",
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

      await deliverResult(result, stream, ctx, bot.api, chatId, sanitized);
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

  // Handle photo messages — download image and let Claude read it
  bot.on("message:photo", async (ctx) => {
    const chatId = ctx.chat.id;
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    const caption = ctx.message.caption ?? "Describe this image";
    const sanitized = sanitizeForPrompt(caption);

    let cleanup: (() => Promise<void>) | undefined;

    const stopButton = new InlineKeyboard().text("Stop", `stop:${chatId}`);
    const stream = createTelegramStream({
      api: bot.api,
      chatId,
      replyToMessageId: ctx.message.message_id,
      replyMarkup: { inline_keyboard: stopButton.inline_keyboard },
      initialText: "⏳ Working...",
    });

    try {
      const downloaded = await downloadTelegramPhoto(
        config.telegramBotToken,
        largest.file_id,
      );
      cleanup = downloaded.cleanup;

      const prompt = `The user sent an image. First, use the Read tool to view this image file: ${downloaded.localPath}\n\nThen respond to the user's request: ${sanitized}`;

      const result = await sendMessage({
        chatId,
        prompt,
        mcpConfigPath: opts.mcpConfigPath,
        onText: (accumulatedText) => {
          stream.update(accumulatedText);
        },
      });

      await deliverResult(result, stream, ctx, bot.api, chatId, sanitized);
    } catch (err) {
      await stream.clear();
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Error: ${msg}`);
    } finally {
      await cleanup?.();
      if (opts.scheduler) {
        await processInbox(chatId, config.workspaceDir, opts.scheduler, bot.api)
          .catch(err => console.warn("[inbox] Failed:", err));
      }
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
