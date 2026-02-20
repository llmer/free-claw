/**
 * Emoji reaction feedback — message tracking, daily log writing, react-back logic.
 *
 * Captures user reactions to bot messages and appends them to the daily memory log,
 * feeding the existing memory → MEMORY.md → SOUL.md growth pipeline.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

// ---------------------------------------------------------------------------
// Message tracker — bounded in-memory cache of what the bot said
// ---------------------------------------------------------------------------

type TrackedMessage = {
  text: string; // first ~200 chars of response
  prompt: string; // first ~100 chars of user's prompt
  timestamp: number;
};

const MAX_PER_CHAT = 100;

// Map<chatId, Map<messageId, TrackedMessage>>
const cache = new Map<number, Map<number, TrackedMessage>>();

export function trackMessage(
  chatId: number,
  messageId: number,
  entry: { text: string; prompt: string },
): void {
  let chatMap = cache.get(chatId);
  if (!chatMap) {
    chatMap = new Map();
    cache.set(chatId, chatMap);
  }

  // Evict oldest if at capacity
  if (chatMap.size >= MAX_PER_CHAT) {
    const oldest = chatMap.keys().next().value!;
    chatMap.delete(oldest);
  }

  chatMap.set(messageId, {
    text: entry.text.slice(0, 200),
    prompt: entry.prompt.slice(0, 100),
    timestamp: Date.now(),
  });
}

/** Also track additional message IDs that carry the same response (chunked sends). */
export function trackMessageIds(
  chatId: number,
  messageIds: number[],
  entry: { text: string; prompt: string },
): void {
  for (const id of messageIds) {
    trackMessage(chatId, id, entry);
  }
}

export function getTracked(
  chatId: number,
  messageId: number,
): TrackedMessage | undefined {
  return cache.get(chatId)?.get(messageId);
}

// ---------------------------------------------------------------------------
// Daily log writer — appends feedback entries to memory/YYYY-MM-DD.md
// ---------------------------------------------------------------------------

function todayFilename(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}.md`;
}

export async function writeFeedback(entry: {
  emoji: string;
  snippet: string;
  context: string;
  timestamp: Date;
}): Promise<void> {
  const memoryDir = path.join(config.workspaceDir, "memory");
  const filePath = path.join(memoryDir, todayFilename());

  // Build the feedback line
  const contextPart = entry.context
    ? ` (asked: "${entry.context}")`
    : "";
  const line = `- ${entry.emoji} on: "${entry.snippet}"${contextPart}\n`;

  // Read existing file (or start empty)
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    content = "";
  }

  if (content.includes("### Feedback")) {
    // Append to existing Feedback section (at the end of it)
    // Find the section and append the line after the last entry in it
    const idx = content.indexOf("### Feedback");
    // Find the next section heading or end of file
    const afterHeading = content.indexOf("\n", idx);
    const rest = content.slice(afterHeading + 1);
    const nextSection = rest.search(/\n### /);
    if (nextSection === -1) {
      // Feedback is the last section — append at end
      content = content.trimEnd() + "\n" + line;
    } else {
      // Insert before the next section
      const insertAt = afterHeading + 1 + nextSection;
      content =
        content.slice(0, insertAt).trimEnd() +
        "\n" +
        line +
        "\n" +
        content.slice(insertAt + 1);
    }
  } else {
    // Create new Feedback section at end of file
    content = content.trimEnd() + "\n\n### Feedback\n" + line;
  }

  await fs.mkdir(memoryDir, { recursive: true });
  await fs.writeFile(filePath, content);
}

// ---------------------------------------------------------------------------
// React-back logic — respond with the bot's identity emoji or mirror
// ---------------------------------------------------------------------------

const POSITIVE = new Set(["👍", "❤", "❤️", "🔥", "🎉", "💯", "⚡", "🏆", "🤩", "🥰", "😍", "👏", "🙏"]);
const MIRROR = new Set(["😂", "🤔", "😢", "😱", "🤯", "😁", "😎", "🤣", "👀", "🤗"]);
const NEGATIVE = new Set(["👎", "💩", "🤮", "🖕"]);

// Telegram only allows these emojis as reactions (subset of Unicode emoji)
const TELEGRAM_REACTION_EMOJI = new Set([
  "👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢",
  "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳",
  "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓",
  "🍾", "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈",
  "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿",
  "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀", "😡",
]);
const FALLBACK_REACT = "❤";

let cachedBotEmoji: string | null = null;

async function loadBotEmoji(): Promise<string | null> {
  if (cachedBotEmoji) return cachedBotEmoji;
  try {
    const content = await fs.readFile(
      path.join(config.workspaceDir, "IDENTITY.md"),
      "utf-8",
    );
    const patterns = [
      /\*\*Emoji:\*\*\s*(.+)/i,
      /-\s*\*\*Emoji:\*\*\s*(.+)/i,
      /Emoji:\s*(.+)/i,
    ];
    for (const re of patterns) {
      const m = content.match(re);
      if (m?.[1]?.trim()) {
        cachedBotEmoji = m[1].trim();
        return cachedBotEmoji;
      }
    }
  } catch {
    // IDENTITY.md not found or unreadable
  }
  return null;
}

/** Clear cached bot emoji (e.g. after identity update). */
export function clearBotEmojiCache(): void {
  cachedBotEmoji = null;
}

/**
 * Determine what emoji the bot should react back with, or null to stay silent.
 */
export async function getReactBackEmoji(
  userEmoji: string,
): Promise<string | null> {
  if (NEGATIVE.has(userEmoji)) return null;

  if (MIRROR.has(userEmoji)) return userEmoji;

  if (POSITIVE.has(userEmoji)) {
    const botEmoji = await loadBotEmoji();
    if (botEmoji && TELEGRAM_REACTION_EMOJI.has(botEmoji)) return botEmoji;
    return FALLBACK_REACT;
  }

  // Unknown emoji — don't react
  return null;
}
