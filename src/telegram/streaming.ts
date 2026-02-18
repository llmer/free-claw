import type { Bot } from "grammy";

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
}): TelegramStream {
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const minInitialChars = params.minInitialChars ?? DEFAULT_MIN_INITIAL_CHARS;
  const chatId = params.chatId;

  let streamMessageId: number | undefined;
  let lastSentText = "";
  let pendingText = "";
  let stopped = false;
  let isFinal = false;
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<boolean | void> | null = null;

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

    try {
      if (streamMessageId !== undefined) {
        await params.api.editMessageText(chatId, streamMessageId, trimmed);
        return true;
      }

      const replyParams = params.replyToMessageId
        ? { reply_to_message_id: params.replyToMessageId }
        : {};
      const sent = await params.api.sendMessage(chatId, trimmed, replyParams);
      if (typeof sent?.message_id === "number") {
        streamMessageId = sent.message_id;
        return true;
      }
      stopped = true;
      return false;
    } catch {
      stopped = true;
      return false;
    }
  };

  const doFlush = async () => {
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
    isFinal = true;
    await flush();
  };

  const clear = async () => {
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
