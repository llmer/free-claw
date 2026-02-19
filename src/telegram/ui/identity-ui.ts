/**
 * Identity viewer/editor Composer — /soul command.
 */

import { Composer, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../../config.js";
import { chunkText } from "../streaming.js";
import { buildGridWithCustom } from "./keyboards.js";

// --- Parsing helpers ---

/**
 * Parse a markdown field value from `**Field:** value` or `- **Field:** value`.
 * Lenient — handles reformatted files.
 */
function parseMarkdownField(content: string, field: string): string {
  const patterns = [
    new RegExp(`\\*\\*${field}:\\*\\*\\s*(.+)`, "i"),
    new RegExp(`-\\s*\\*\\*${field}:\\*\\*\\s*(.+)`, "i"),
    new RegExp(`${field}:\\s*(.+)`, "i"),
  ];
  for (const re of patterns) {
    const m = content.match(re);
    if (m && m[1]?.trim()) return m[1].trim();
  }
  return "";
}

type IdentityData = {
  name: string;
  creature: string;
  vibe: string;
  emoji: string;
};

type UserData = {
  name: string;
  timezone: string;
};

async function readIdentity(): Promise<IdentityData> {
  try {
    const content = await fs.readFile(path.join(config.workspaceDir, "IDENTITY.md"), "utf-8");
    return {
      name: parseMarkdownField(content, "Name"),
      creature: parseMarkdownField(content, "Creature"),
      vibe: parseMarkdownField(content, "Vibe"),
      emoji: parseMarkdownField(content, "Emoji"),
    };
  } catch {
    return { name: "", creature: "", vibe: "", emoji: "" };
  }
}

async function readUser(): Promise<UserData> {
  try {
    const content = await fs.readFile(path.join(config.workspaceDir, "USER.md"), "utf-8");
    return {
      name: parseMarkdownField(content, "Name"),
      timezone: parseMarkdownField(content, "Timezone"),
    };
  } catch {
    return { name: "", timezone: "" };
  }
}

/**
 * Update a single field in a markdown file.
 * Replaces `**Field:** old_value` with `**Field:** new_value`.
 */
async function updateField(filename: string, field: string, value: string): Promise<boolean> {
  const filePath = path.join(config.workspaceDir, filename);
  try {
    let content = await fs.readFile(filePath, "utf-8");
    const patterns = [
      new RegExp(`(\\*\\*${field}:\\*\\*\\s*).+`, "i"),
      new RegExp(`(-\\s*\\*\\*${field}:\\*\\*\\s*).+`, "i"),
    ];
    let replaced = false;
    for (const re of patterns) {
      if (re.test(content)) {
        content = content.replace(re, `$1${value}`);
        replaced = true;
        break;
      }
    }
    if (!replaced) return false;
    await fs.writeFile(filePath, content);
    return true;
  } catch {
    return false;
  }
}

// --- Options for editing ---

const NAME_OPTIONS: [string, string][] = [
  ["Cleo", "id:set:name:Cleo"], ["Sage", "id:set:name:Sage"],
  ["Echo", "id:set:name:Echo"], ["Nova", "id:set:name:Nova"],
  ["Wren", "id:set:name:Wren"], ["Hex", "id:set:name:Hex"],
];

const CREATURE_OPTIONS: [string, string][] = [
  ["AI assistant", "id:set:crt:AI assistant"],
  ["Digital familiar", "id:set:crt:Digital familiar"],
  ["Ghost in the machine", "id:set:crt:Ghost in the machine"],
  ["Daemon process", "id:set:crt:Daemon process"],
  ["Robot companion", "id:set:crt:Robot companion"],
];

const VIBE_OPTIONS: [string, string][] = [
  ["Warm & friendly", "id:set:vibe:Warm & friendly"],
  ["Sharp & witty", "id:set:vibe:Sharp & witty"],
  ["Calm & steady", "id:set:vibe:Calm & steady"],
  ["Chaotic & creative", "id:set:vibe:Chaotic & creative"],
  ["Snarky & direct", "id:set:vibe:Snarky & direct"],
];

const EMOJI_OPTIONS: [string, string][] = [
  ["🐱", "id:set:emo:🐱"], ["👻", "id:set:emo:👻"], ["🤖", "id:set:emo:🤖"],
  ["🦊", "id:set:emo:🦊"], ["🔮", "id:set:emo:🔮"], ["🌙", "id:set:emo:🌙"],
  ["⚡", "id:set:emo:⚡"], ["🎭", "id:set:emo:🎭"], ["🧠", "id:set:emo:🧠"],
  ["🌿", "id:set:emo:🌿"], ["🐙", "id:set:emo:🐙"], ["✨", "id:set:emo:✨"],
];

function buildIdentityCard(id: IdentityData, user: UserData): string {
  const lines = ["Your assistant's identity:\n"];
  lines.push(`Name: ${id.name || "(not set)"}`);
  lines.push(`Creature: ${id.creature || "(not set)"}`);
  lines.push(`Vibe: ${id.vibe || "(not set)"}`);
  lines.push(`Emoji: ${id.emoji || "(not set)"}`);
  lines.push("");
  lines.push("Your info:");
  lines.push(`Name: ${user.name || "(not set)"}`);
  lines.push(`Timezone: ${user.timezone || "(not set)"}`);
  return lines.join("\n");
}

function buildIdentityKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Edit name", "id:ed:name")
    .text("Edit creature", "id:ed:crt")
    .row()
    .text("Edit vibe", "id:ed:vibe")
    .text("Edit emoji", "id:ed:emo")
    .row()
    .text("View SOUL.md", "id:soul");
}

export function createIdentityComposer(): Composer<Context> {
  const composer = new Composer<Context>();

  // /soul command
  composer.command("soul", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const [id, user] = await Promise.all([readIdentity(), readUser()]);
    const text = buildIdentityCard(id, user);
    await ctx.reply(text, { reply_markup: buildIdentityKeyboard() });
  });

  // Callback queries with id: prefix
  composer.callbackQuery(/^id:/, async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery();

    // --- Show identity card ---
    if (data === "id:show" || data === "id:back") {
      const [id, user] = await Promise.all([readIdentity(), readUser()]);
      const text = buildIdentityCard(id, user);
      try {
        await ctx.editMessageText(text, { reply_markup: buildIdentityKeyboard() });
      } catch {
        await ctx.reply(text, { reply_markup: buildIdentityKeyboard() });
      }
      return;
    }

    // --- Edit name picker ---
    if (data === "id:ed:name") {
      const kb = buildGridWithCustom(NAME_OPTIONS, "id:set:name:_", 3);
      kb.row().text("« Back", "id:back");
      try {
        await ctx.editMessageText("Choose a new name:", { reply_markup: kb });
      } catch {
        await ctx.reply("Choose a new name:", { reply_markup: kb });
      }
      return;
    }

    // --- Edit creature picker ---
    if (data === "id:ed:crt") {
      const kb = buildGridWithCustom(CREATURE_OPTIONS, "id:set:crt:_", 2);
      kb.row().text("« Back", "id:back");
      try {
        await ctx.editMessageText("Choose a creature type:", { reply_markup: kb });
      } catch {
        await ctx.reply("Choose a creature type:", { reply_markup: kb });
      }
      return;
    }

    // --- Edit vibe picker ---
    if (data === "id:ed:vibe") {
      const kb = buildGridWithCustom(VIBE_OPTIONS, "id:set:vibe:_", 2);
      kb.row().text("« Back", "id:back");
      try {
        await ctx.editMessageText("Choose a vibe:", { reply_markup: kb });
      } catch {
        await ctx.reply("Choose a vibe:", { reply_markup: kb });
      }
      return;
    }

    // --- Edit emoji picker ---
    if (data === "id:ed:emo") {
      const kb = buildGridWithCustom(EMOJI_OPTIONS, "id:set:emo:_", 4);
      kb.row().text("« Back", "id:back");
      try {
        await ctx.editMessageText("Choose an emoji:", { reply_markup: kb });
      } catch {
        await ctx.reply("Choose an emoji:", { reply_markup: kb });
      }
      return;
    }

    // --- Set field values ---
    if (data.startsWith("id:set:name:")) {
      const val = data.slice("id:set:name:".length);
      if (val !== "_") {
        await updateField("IDENTITY.md", "Name", val);
      }
      // Return to card
      const [id, user] = await Promise.all([readIdentity(), readUser()]);
      const text = buildIdentityCard(id, user);
      try {
        await ctx.editMessageText(text, { reply_markup: buildIdentityKeyboard() });
      } catch {
        await ctx.reply(text, { reply_markup: buildIdentityKeyboard() });
      }
      return;
    }

    if (data.startsWith("id:set:crt:")) {
      const val = data.slice("id:set:crt:".length);
      if (val !== "_") {
        await updateField("IDENTITY.md", "Creature", val);
      }
      const [id, user] = await Promise.all([readIdentity(), readUser()]);
      const text = buildIdentityCard(id, user);
      try {
        await ctx.editMessageText(text, { reply_markup: buildIdentityKeyboard() });
      } catch {
        await ctx.reply(text, { reply_markup: buildIdentityKeyboard() });
      }
      return;
    }

    if (data.startsWith("id:set:vibe:")) {
      const val = data.slice("id:set:vibe:".length);
      if (val !== "_") {
        await updateField("IDENTITY.md", "Vibe", val);
      }
      const [id, user] = await Promise.all([readIdentity(), readUser()]);
      const text = buildIdentityCard(id, user);
      try {
        await ctx.editMessageText(text, { reply_markup: buildIdentityKeyboard() });
      } catch {
        await ctx.reply(text, { reply_markup: buildIdentityKeyboard() });
      }
      return;
    }

    if (data.startsWith("id:set:emo:")) {
      const val = data.slice("id:set:emo:".length);
      if (val !== "_") {
        await updateField("IDENTITY.md", "Emoji", val);
      }
      const [id, user] = await Promise.all([readIdentity(), readUser()]);
      const text = buildIdentityCard(id, user);
      try {
        await ctx.editMessageText(text, { reply_markup: buildIdentityKeyboard() });
      } catch {
        await ctx.reply(text, { reply_markup: buildIdentityKeyboard() });
      }
      return;
    }

    // --- View SOUL.md ---
    if (data === "id:soul") {
      const soulPath = path.join(config.workspaceDir, "SOUL.md");
      let content: string;
      try {
        content = await fs.readFile(soulPath, "utf-8");
      } catch {
        content = "(SOUL.md not found)";
      }

      const kb = new InlineKeyboard().text("« Back", "id:back");
      const chunks = chunkText(content, 4000);

      if (chunks.length === 1) {
        try {
          await ctx.editMessageText(chunks[0], { reply_markup: kb });
        } catch {
          await ctx.reply(chunks[0], { reply_markup: kb });
        }
      } else {
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
  });

  return composer;
}
