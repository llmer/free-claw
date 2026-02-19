/**
 * Onboarding wizard Composer — replaces BOOTSTRAP.md.
 * Multi-step inline keyboard flow to set up identity.
 */

import { Composer } from "grammy";
import type { Context } from "grammy";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../../config.js";
import { TEMPLATE_IDENTITY, TEMPLATE_USER } from "../../workspace/templates.js";
import {
  getOnboardingState,
  setOnboardingState,
  clearOnboardingState,
  hasActiveOnboarding,
  type OnboardingState,
  type OnboardingStep,
} from "./state.js";
import { buildGridWithCustom, confirmCancel } from "./keyboards.js";

// --- Options ---

const NAME_OPTIONS: [string, string][] = [
  ["Cleo", "ob:name:Cleo"],
  ["Sage", "ob:name:Sage"],
  ["Echo", "ob:name:Echo"],
  ["Nova", "ob:name:Nova"],
  ["Wren", "ob:name:Wren"],
  ["Hex", "ob:name:Hex"],
];

const CREATURE_OPTIONS: [string, string][] = [
  ["AI assistant", "ob:crt:AI assistant"],
  ["Digital familiar", "ob:crt:Digital familiar"],
  ["Ghost in the machine", "ob:crt:Ghost in the machine"],
  ["Daemon process", "ob:crt:Daemon process"],
  ["Robot companion", "ob:crt:Robot companion"],
];

const VIBE_OPTIONS: [string, string][] = [
  ["Warm & friendly", "ob:vibe:Warm & friendly"],
  ["Sharp & witty", "ob:vibe:Sharp & witty"],
  ["Calm & steady", "ob:vibe:Calm & steady"],
  ["Chaotic & creative", "ob:vibe:Chaotic & creative"],
  ["Snarky & direct", "ob:vibe:Snarky & direct"],
];

const EMOJI_OPTIONS: [string, string][] = [
  ["🐱", "ob:emo:🐱"], ["👻", "ob:emo:👻"], ["🤖", "ob:emo:🤖"],
  ["🦊", "ob:emo:🦊"], ["🔮", "ob:emo:🔮"], ["🌙", "ob:emo:🌙"],
  ["⚡", "ob:emo:⚡"], ["🎭", "ob:emo:🎭"], ["🧠", "ob:emo:🧠"],
  ["🌿", "ob:emo:🌿"], ["🐙", "ob:emo:🐙"], ["✨", "ob:emo:✨"],
];

const TZ_OPTIONS: [string, string][] = [
  ["US Eastern", "ob:tz:America/New_York"],
  ["US Central", "ob:tz:America/Chicago"],
  ["US Mountain", "ob:tz:America/Denver"],
  ["US Pacific", "ob:tz:America/Los_Angeles"],
  ["UTC", "ob:tz:UTC"],
  ["Europe/London", "ob:tz:Europe/London"],
  ["Europe/Berlin", "ob:tz:Europe/Berlin"],
  ["Asia/Tokyo", "ob:tz:Asia/Tokyo"],
];

// --- Step rendering ---

type StepConfig = {
  text: string;
  options: [string, string][];
  customData: string;
  columns?: number;
};

const STEP_MAP: Record<string, StepConfig> = {
  name: {
    text: "Let's set up your assistant's identity!\n\nWhat should they be called?",
    options: NAME_OPTIONS,
    customData: "ob:name:_",
    columns: 3,
  },
  creature: {
    text: "What kind of creature are they?",
    options: CREATURE_OPTIONS,
    customData: "ob:crt:_",
  },
  vibe: {
    text: "What's their vibe?",
    options: VIBE_OPTIONS,
    customData: "ob:vibe:_",
  },
  emoji: {
    text: "Pick a signature emoji:",
    options: EMOJI_OPTIONS,
    customData: "ob:emo:_",
    columns: 4,
  },
  user_tz: {
    text: "What's your timezone?",
    options: TZ_OPTIONS,
    customData: "ob:tz:_",
    columns: 2,
  },
};

function buildStepText(state: OnboardingState): string {
  const cfg = STEP_MAP[state.step];
  if (cfg) return cfg.text;

  if (state.step === "user_name") {
    return "What should the assistant call you?\n\nType your name:";
  }

  if (state.step === "confirm") {
    return (
      "Here's your setup:\n\n" +
      `Name: ${state.name}\n` +
      `Creature: ${state.creature}\n` +
      `Vibe: ${state.vibe}\n` +
      `Emoji: ${state.emoji}\n\n` +
      `Your name: ${state.userName}\n` +
      `Timezone: ${state.userTimezone}\n\n` +
      "Look good?"
    );
  }

  // _custom steps
  if (state.step === "name_custom") return "Type a name for your assistant:";
  if (state.step === "creature_custom") return "What kind of creature? Type your answer:";
  if (state.step === "vibe_custom") return "Describe the vibe you want:";
  if (state.step === "emoji_custom") return "Send an emoji:";
  if (state.step === "user_tz_custom") return "Type your timezone (IANA format, e.g. America/New_York):";

  return "...";
}

function buildStepKeyboard(state: OnboardingState) {
  const cfg = STEP_MAP[state.step];
  if (cfg) {
    return buildGridWithCustom(cfg.options, cfg.customData, cfg.columns ?? 2);
  }

  if (state.step === "confirm") {
    return confirmCancel("ob:confirm", "ob:restart", "Looks good!", "Start over");
  }

  // Text input steps — no keyboard
  return undefined;
}

// --- Edit or send wizard message ---

async function renderStep(ctx: Context, chatId: number, state: OnboardingState): Promise<void> {
  const text = buildStepText(state);
  const keyboard = buildStepKeyboard(state);
  const opts = keyboard ? { reply_markup: keyboard } : {};

  if (state.messageId) {
    try {
      await ctx.api.editMessageText(chatId, state.messageId, text, opts);
      setOnboardingState(chatId, state);
      return;
    } catch {
      // Message too old or deleted — fall through to send new one
    }
  }

  const sent = await ctx.api.sendMessage(chatId, text, opts);
  state.messageId = sent.message_id;
  setOnboardingState(chatId, state);
}

// --- Step advancement ---

const STEP_ORDER: OnboardingStep[] = [
  "name", "creature", "vibe", "emoji", "user_name", "user_tz", "confirm",
];

function advanceStep(state: OnboardingState): void {
  const currentBase = state.step.replace(/_custom$/, "") as OnboardingStep;
  const idx = STEP_ORDER.indexOf(currentBase);
  if (idx >= 0 && idx < STEP_ORDER.length - 1) {
    state.step = STEP_ORDER[idx + 1];
  }
}

// --- File writing ---

function buildIdentityContent(state: OnboardingState): string {
  return (
    `# IDENTITY.md - Who Am I?\n\n` +
    `- **Name:** ${state.name}\n` +
    `- **Creature:** ${state.creature}\n` +
    `- **Vibe:** ${state.vibe}\n` +
    `- **Emoji:** ${state.emoji}\n\n` +
    `---\n\n` +
    `This isn't just metadata. It's the start of figuring out who you are.\n`
  );
}

function buildUserContent(state: OnboardingState): string {
  return (
    `# USER.md - About Your Human\n\n` +
    `- **Name:** ${state.userName}\n` +
    `- **What to call them:** ${state.userName}\n` +
    `- **Pronouns:**\n` +
    `- **Timezone:** ${state.userTimezone}\n` +
    `- **Notes:**\n\n` +
    `## Context\n\n` +
    `_(Build this over time as you learn about your human.)_\n\n` +
    `---\n\n` +
    `The more you know, the better you can help. But remember — you're learning about a person, not building a dossier. Respect the difference.\n`
  );
}

async function writeIdentityFiles(state: OnboardingState): Promise<void> {
  const dir = config.workspaceDir;

  await Promise.all([
    fs.writeFile(path.join(dir, "IDENTITY.md"), buildIdentityContent(state)),
    fs.writeFile(path.join(dir, "USER.md"), buildUserContent(state)),
  ]);

  // Delete BOOTSTRAP.md if present
  try {
    await fs.unlink(path.join(dir, "BOOTSTRAP.md"));
  } catch {
    // Already gone
  }

  console.log("[onboarding] Wrote IDENTITY.md and USER.md");
}

// --- Composer ---

export function createOnboardingComposer(): Composer<Context> {
  const composer = new Composer<Context>();

  // /setup command
  composer.command("setup", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    await startOnboardingWizard(ctx);
  });

  // Callback queries with ob: prefix
  composer.callbackQuery(/^ob:/, async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const data = ctx.callbackQuery.data;
    const state = getOnboardingState(chatId);

    if (!state) {
      await ctx.answerCallbackQuery({ text: "Session expired. Run /setup again." });
      return;
    }

    await ctx.answerCallbackQuery();

    // --- Name ---
    if (data.startsWith("ob:name:")) {
      const val = data.slice("ob:name:".length);
      if (val === "_") {
        state.step = "name_custom";
        await renderStep(ctx, chatId, state);
        return;
      }
      state.name = val;
      advanceStep(state);
      await renderStep(ctx, chatId, state);
      return;
    }

    // --- Creature ---
    if (data.startsWith("ob:crt:")) {
      const val = data.slice("ob:crt:".length);
      if (val === "_") {
        state.step = "creature_custom";
        await renderStep(ctx, chatId, state);
        return;
      }
      state.creature = val;
      advanceStep(state);
      await renderStep(ctx, chatId, state);
      return;
    }

    // --- Vibe ---
    if (data.startsWith("ob:vibe:")) {
      const val = data.slice("ob:vibe:".length);
      if (val === "_") {
        state.step = "vibe_custom";
        await renderStep(ctx, chatId, state);
        return;
      }
      state.vibe = val;
      advanceStep(state);
      await renderStep(ctx, chatId, state);
      return;
    }

    // --- Emoji ---
    if (data.startsWith("ob:emo:")) {
      const val = data.slice("ob:emo:".length);
      if (val === "_") {
        state.step = "emoji_custom";
        await renderStep(ctx, chatId, state);
        return;
      }
      state.emoji = val;
      advanceStep(state);
      await renderStep(ctx, chatId, state);
      return;
    }

    // --- Timezone ---
    if (data.startsWith("ob:tz:")) {
      const val = data.slice("ob:tz:".length);
      if (val === "_") {
        state.step = "user_tz_custom";
        await renderStep(ctx, chatId, state);
        return;
      }
      state.userTimezone = val;
      advanceStep(state);
      await renderStep(ctx, chatId, state);
      return;
    }

    // --- Confirm ---
    if (data === "ob:confirm") {
      try {
        await writeIdentityFiles(state);
        clearOnboardingState(chatId);

        // Edit the wizard message to show completion
        if (state.messageId) {
          try {
            await ctx.api.editMessageText(
              chatId,
              state.messageId,
              `Setup complete! ${state.emoji}\n\n` +
              `${state.name} the ${state.creature?.toLowerCase()} is ready.\n\n` +
              `Send a message to start chatting.`,
            );
          } catch {
            await ctx.api.sendMessage(
              chatId,
              `Setup complete! ${state.emoji}\n\n` +
              `${state.name} the ${state.creature?.toLowerCase()} is ready.\n\n` +
              `Send a message to start chatting.`,
            );
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.api.sendMessage(chatId, `Error saving identity: ${msg}`);
      }
      return;
    }

    // --- Restart ---
    if (data === "ob:restart") {
      const newState: OnboardingState = {
        step: "name",
        messageId: state.messageId,
        startedAt: Date.now(),
      };
      setOnboardingState(chatId, newState);
      await renderStep(ctx, chatId, newState);
      return;
    }
  });

  return composer;
}

/**
 * Handle text messages during onboarding (custom input).
 * Returns true if the message was consumed by the wizard.
 */
export async function handleOnboardingText(ctx: Context): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (!chatId) return false;
  if (!hasActiveOnboarding(chatId)) return false;

  const state = getOnboardingState(chatId);
  if (!state) return false;

  const text = ctx.message?.text?.trim();
  if (!text) return false;

  // Delete the user's text message to keep chat clean
  try {
    if (ctx.message?.message_id) {
      await ctx.api.deleteMessage(chatId, ctx.message.message_id);
    }
  } catch {
    // Best effort
  }

  switch (state.step) {
    case "name_custom":
      state.name = text;
      advanceStep(state);
      break;
    case "creature_custom":
      state.creature = text;
      advanceStep(state);
      break;
    case "vibe_custom":
      state.vibe = text;
      advanceStep(state);
      break;
    case "emoji_custom":
      state.emoji = text;
      advanceStep(state);
      break;
    case "user_name":
      state.userName = text;
      advanceStep(state);
      break;
    case "user_tz_custom": {
      // Validate timezone
      try {
        Intl.DateTimeFormat(undefined, { timeZone: text });
      } catch {
        await ctx.api.sendMessage(chatId, `Invalid timezone: "${text}". Try again (e.g. America/New_York):`);
        return true;
      }
      state.userTimezone = text;
      advanceStep(state);
      break;
    }
    default:
      return false;
  }

  await renderStep(ctx, chatId, state);
  return true;
}

/**
 * Programmatic trigger for the onboarding wizard (called from /start).
 */
export async function startOnboardingWizard(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const state: OnboardingState = {
    step: "name",
    startedAt: Date.now(),
  };

  setOnboardingState(chatId, state);
  await renderStep(ctx, chatId, state);
}
