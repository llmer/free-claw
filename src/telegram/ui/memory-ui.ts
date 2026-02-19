/**
 * Memory browser Composer — /memory command with inline keyboard navigation.
 */

import { Composer, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../../config.js";
import { chunkText } from "../streaming.js";

const PREVIEW_LENGTH = 500;
const LOGS_PER_PAGE = 10;

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function listDailyLogs(workspaceDir: string): Promise<string[]> {
  const memoryDir = path.join(workspaceDir, "memory");
  try {
    const entries = await fs.readdir(memoryDir);
    return entries
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse(); // newest first
  } catch {
    return [];
  }
}

export function createMemoryComposer(): Composer<Context> {
  const composer = new Composer<Context>();

  // /memory command
  composer.command("memory", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const memoryPath = path.join(config.workspaceDir, "MEMORY.md");
    const content = await readFileOrNull(memoryPath);
    const logs = await listDailyLogs(config.workspaceDir);

    let text: string;
    if (!content || content.trim().length === 0) {
      text = "MEMORY.md is empty.";
    } else {
      const preview = content.slice(0, PREVIEW_LENGTH);
      text = preview + (content.length > PREVIEW_LENGTH ? "\n\n..." : "");
    }

    if (logs.length > 0) {
      text += `\n\n${logs.length} daily log(s) available.`;
    }

    const kb = new InlineKeyboard();
    if (content && content.length > PREVIEW_LENGTH) {
      kb.text("View full memory", "mem:full").row();
    }
    if (logs.length > 0) {
      kb.text(`Daily logs (${logs.length})`, "mem:logs").row();
    }

    await ctx.reply(text, { reply_markup: kb });
  });

  // Callback queries with mem: prefix
  composer.callbackQuery(/^mem:/, async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery();

    // --- Main view ---
    if (data === "mem:main") {
      const memoryPath = path.join(config.workspaceDir, "MEMORY.md");
      const content = await readFileOrNull(memoryPath);
      const logs = await listDailyLogs(config.workspaceDir);

      let text: string;
      if (!content || content.trim().length === 0) {
        text = "MEMORY.md is empty.";
      } else {
        const preview = content.slice(0, PREVIEW_LENGTH);
        text = preview + (content.length > PREVIEW_LENGTH ? "\n\n..." : "");
      }

      if (logs.length > 0) {
        text += `\n\n${logs.length} daily log(s) available.`;
      }

      const kb = new InlineKeyboard();
      if (content && content.length > PREVIEW_LENGTH) {
        kb.text("View full memory", "mem:full").row();
      }
      if (logs.length > 0) {
        kb.text(`Daily logs (${logs.length})`, "mem:logs").row();
      }

      try {
        await ctx.editMessageText(text, { reply_markup: kb });
      } catch {
        await ctx.reply(text, { reply_markup: kb });
      }
      return;
    }

    // --- Full memory ---
    if (data === "mem:full") {
      const memoryPath = path.join(config.workspaceDir, "MEMORY.md");
      const content = await readFileOrNull(memoryPath);

      if (!content || content.trim().length === 0) {
        try {
          await ctx.editMessageText("MEMORY.md is empty.", {
            reply_markup: new InlineKeyboard().text("« Back", "mem:main"),
          });
        } catch {
          await ctx.reply("MEMORY.md is empty.");
        }
        return;
      }

      // Chunk if too long
      const chunks = chunkText(content, 4000);
      const kb = new InlineKeyboard().text("« Back", "mem:main");

      if (chunks.length === 1) {
        try {
          await ctx.editMessageText(chunks[0], { reply_markup: kb });
        } catch {
          await ctx.reply(chunks[0], { reply_markup: kb });
        }
      } else {
        // First chunk edits the message, rest are new messages
        try {
          await ctx.editMessageText(chunks[0]);
        } catch {
          await ctx.reply(chunks[0]);
        }
        for (let i = 1; i < chunks.length; i++) {
          const isLast = i === chunks.length - 1;
          await ctx.reply(chunks[i], isLast ? { reply_markup: kb } : {});
        }
      }
      return;
    }

    // --- Daily logs list ---
    if (data === "mem:logs" || data.startsWith("mem:logs:")) {
      const page = data === "mem:logs" ? 0 : parseInt(data.slice("mem:logs:".length), 10);
      const logs = await listDailyLogs(config.workspaceDir);

      if (logs.length === 0) {
        try {
          await ctx.editMessageText("No daily logs yet.", {
            reply_markup: new InlineKeyboard().text("« Back", "mem:main"),
          });
        } catch {
          await ctx.reply("No daily logs yet.");
        }
        return;
      }

      const start = page * LOGS_PER_PAGE;
      const pageItems = logs.slice(start, start + LOGS_PER_PAGE);
      const totalPages = Math.ceil(logs.length / LOGS_PER_PAGE);

      const kb = new InlineKeyboard();
      for (const filename of pageItems) {
        const date = filename.replace(".md", "");
        kb.text(date, `mem:d:${date}`).row();
      }

      // Pagination
      if (totalPages > 1) {
        if (page > 0) kb.text("« Prev", `mem:logs:${page - 1}`);
        kb.text(`${page + 1}/${totalPages}`, "mem:noop");
        if (page < totalPages - 1) kb.text("Next »", `mem:logs:${page + 1}`);
        kb.row();
      }

      kb.text("« Back", "mem:main");

      const text = `Daily logs (${logs.length} total):`;
      try {
        await ctx.editMessageText(text, { reply_markup: kb });
      } catch {
        await ctx.reply(text, { reply_markup: kb });
      }
      return;
    }

    // --- Single daily log ---
    if (data.startsWith("mem:d:")) {
      const date = data.slice("mem:d:".length);
      const logPath = path.join(config.workspaceDir, "memory", `${date}.md`);
      const content = await readFileOrNull(logPath);

      const kb = new InlineKeyboard().text("« Back to logs", "mem:logs");

      if (!content || content.trim().length === 0) {
        try {
          await ctx.editMessageText(`${date}: (empty)`, { reply_markup: kb });
        } catch {
          await ctx.reply(`${date}: (empty)`, { reply_markup: kb });
        }
        return;
      }

      const chunks = chunkText(content, 4000);
      if (chunks.length === 1) {
        const text = `${date}:\n\n${chunks[0]}`;
        if (text.length <= 4096) {
          try {
            await ctx.editMessageText(text, { reply_markup: kb });
          } catch {
            await ctx.reply(text, { reply_markup: kb });
          }
        } else {
          try {
            await ctx.editMessageText(chunks[0]);
          } catch {
            await ctx.reply(chunks[0]);
          }
          await ctx.reply("(continued)", { reply_markup: kb });
        }
      } else {
        try {
          await ctx.editMessageText(`${date}:\n\n${chunks[0]}`);
        } catch {
          await ctx.reply(`${date}:\n\n${chunks[0]}`);
        }
        for (let i = 1; i < chunks.length; i++) {
          const isLast = i === chunks.length - 1;
          await ctx.reply(chunks[i], isLast ? { reply_markup: kb } : {});
        }
      }
      return;
    }

    // --- Noop (pagination counter) ---
    if (data === "mem:noop") return;
  });

  return composer;
}
