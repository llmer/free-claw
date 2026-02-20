import type { Bot } from "grammy";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "grammy/types";
import { markdownToTelegramHtml, isTelegramParseError } from "./format.js";

const TELEGRAM_MAX_CHARS = 4096;
const DEFAULT_THROTTLE_MS = 1500;
const DEFAULT_MIN_INITIAL_CHARS = 30;

export type TelegramStream = {
  /** Update accumulated text. The stream will throttle edits. */
  update: (text: string) => void;
  /** Flush any pending update immediately. */
  flush: () => Promise<void>;
  /** Get the current stream message ID. */
  messageId: () => number | undefined;
  /** Delete the stream message (for cancellation). */
  clear: () => Promise<void>;
  /** Stop the stream (final flush). */
  stop: () => Promise<void>;
};

export function createTelegramStream(params: {
  api: Bot["api"];
  chatId: number;
  replyToMessageId?: number;
  throttleMs?: number;
  minInitialChars?: number;
  replyMarkup?: InlineKeyboardMarkup;
  /** If set, immediately send this text as the first message (bypasses minInitialChars). */
  initialText?: string;
}): TelegramStream {
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const minInitialChars = params.minInitialChars ?? DEFAULT_MIN_INITIAL_CHARS;
  const chatId = params.chatId;

  let streamMessageId: number | undefined;
  let lastSentText = "";
  let pendingText = "";
  let stopped = false;
  let isFinal = false;
  let htmlFailed = false;
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<boolean | undefined> | null = null;

  // Send "typing" indicator immediately and refresh every 4s (expires after ~5s)
  const TYPING_INTERVAL_MS = 4_000;
  const sendTyping = () => {
    params.api.sendChatAction(chatId, "typing").catch(() => {});
  };
  sendTyping();
  const typingTimer = setInterval(sendTyping, TYPING_INTERVAL_MS);

  // Send initial placeholder message immediately (with stop button)
  if (params.initialText) {
    const markup = params.replyMarkup ? { reply_markup: params.replyMarkup } : {};
    const replyParams = params.replyToMessageId
      ? { reply_to_message_id: params.replyToMessageId, ...markup }
      : { ...markup };
    // Fire-and-forget but capture the message ID
    inFlight = params.api
      .sendMessage(chatId, params.initialText, replyParams)
      .then((sent) => {
        if (typeof sent?.message_id === "number") {
          streamMessageId = sent.message_id;
          lastSentText = params.initialText!;
        }
        return true;
      })
      .catch(() => {
        return false;
      });
  }

  // Activity indicator: when text stops changing but process is still running,
  // append a visual indicator to the message so the user knows we're still working.
  const ACTIVITY_CHECK_MS = 6_000;
  const ACTIVITY_SUFFIX = "\n\n⏳ Working...";
  let lastRealText = "";
  let lastTextChangeAt = Date.now();
  let showingActivity = false;

  const activityTimer = setInterval(() => {
    if (stopped || isFinal) return;
    if (!streamMessageId) return; // No message sent yet
    if (showingActivity) return; // Already showing
    if (Date.now() - lastTextChangeAt < ACTIVITY_CHECK_MS) return;

    // Text has been stale — show activity indicator in the message
    showingActivity = true;
    const withActivity = lastRealText + ACTIVITY_SUFFIX;
    if (withActivity.trimEnd().length <= TELEGRAM_MAX_CHARS) {
      pendingText = withActivity;
      scheduleFlush();
    }
  }, ACTIVITY_CHECK_MS);

  const stopTyping = () => {
    clearInterval(typingTimer);
    clearInterval(activityTimer);
  };

  const sendOrEdit = async (text: string): Promise<boolean> => {
    if (stopped && !isFinal) return false;

    const trimmed = text.trimEnd();
    if (!trimmed) return false;

    if (trimmed.length > TELEGRAM_MAX_CHARS) {
      // Stop streaming edits when over limit
      stopped = true;
      return false;
    }

    if (trimmed === lastSentText) return true;

    // Debounce first message to avoid noisy push notifications
    if (streamMessageId === undefined && !isFinal) {
      if (trimmed.length < minInitialChars) return false;
    }

    lastSentText = trimmed;

    // During streaming, attach the inline keyboard; on final flush, clear it
    const markup = isFinal
      ? { reply_markup: { inline_keyboard: [] as InlineKeyboardButton[][] } }
      : params.replyMarkup
        ? { reply_markup: params.replyMarkup }
        : {};

    const attempt = async (content: string, parseMode?: "HTML") => {
      const pmOpts = parseMode ? { parse_mode: parseMode } as const : {};
      if (streamMessageId !== undefined) {
        await params.api.editMessageText(chatId, streamMessageId, content, { ...markup, ...pmOpts });
        return true;
      }
      const base = params.replyToMessageId
        ? { reply_to_message_id: params.replyToMessageId }
        : {};
      const sent = await params.api.sendMessage(chatId, content, { ...base, ...markup, ...pmOpts });
      if (typeof sent?.message_id === "number") {
        streamMessageId = sent.message_id;
        return true;
      }
      return false;
    };

    try {
      if (htmlFailed) {
        return await attempt(trimmed);
      }
      return await attempt(markdownToTelegramHtml(trimmed), "HTML");
    } catch (err) {
      if (!htmlFailed && isTelegramParseError(err)) {
        htmlFailed = true;
        try {
          return await attempt(trimmed);
        } catch {
          // fall through
        }
      }
      stopped = true;
      return false;
    }
  };

  const doFlush = async () => {
    // Wait for any in-flight operation (e.g. initial placeholder send) to finish
    // so that streamMessageId is set before we try to edit
    if (inFlight) await inFlight;
    if (!pendingText) return;
    const text = pendingText;
    inFlight = sendOrEdit(text);
    await inFlight;
    inFlight = null;
  };

  const scheduleFlush = () => {
    if (throttleTimer) return;
    throttleTimer = setTimeout(() => {
      throttleTimer = null;
      void doFlush();
    }, throttleMs);
  };

  const update = (text: string) => {
    if (stopped || isFinal) return;
    if (text !== lastRealText) {
      lastRealText = text;
      lastTextChangeAt = Date.now();
      showingActivity = false;
    }
    pendingText = text;
    scheduleFlush();
  };

  const flush = async () => {
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
    if (inFlight) await inFlight;
    await doFlush();
  };

  const stop = async () => {
    stopTyping();
    isFinal = true;
    await flush();
  };

  const clear = async () => {
    stopTyping();
    stopped = true;
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
    if (inFlight) await inFlight;
    const msgId = streamMessageId;
    streamMessageId = undefined;
    if (msgId !== undefined) {
      try {
        await params.api.deleteMessage(chatId, msgId);
      } catch {
        // best-effort
      }
    }
  };

  return {
    update,
    flush,
    messageId: () => streamMessageId,
    clear,
    stop,
  };
}

/**
 * Split text into chunks that fit within Telegram's message limit.
 */
export function chunkText(text: string, maxLen = TELEGRAM_MAX_CHARS): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline near the boundary
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.5) {
      // No good newline split point; split at space
      splitAt = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitAt < maxLen * 0.3) {
      // No good split point at all; hard split
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}
