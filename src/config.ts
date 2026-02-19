import path from "node:path";
import os from "node:os";
import { config as loadEnv } from "dotenv";

loadEnv();

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value?.trim()) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value.trim();
}

export const config = {
  telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),

  allowedUsers: (process.env.ALLOWED_TELEGRAM_USERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0),

  workspaceDir: expandHome(process.env.WORKSPACE_DIR?.trim() || "~/projects"),
  dataDir: expandHome(process.env.DATA_DIR?.trim() || "~/.free-claw"),
  claudeModel: process.env.CLAUDE_MODEL?.trim() || "",
  enableBrowser: process.env.ENABLE_BROWSER?.trim()?.toLowerCase() !== "false",
  timeoutMs: Number(process.env.TIMEOUT_MS) || 600_000,
  noOutputTimeoutMs: Number(process.env.NO_OUTPUT_TIMEOUT_MS) || 180_000,
  defaultTimezone:
    process.env.DEFAULT_TIMEZONE?.trim() ||
    Intl.DateTimeFormat().resolvedOptions().timeZone,
} as const;

export type Config = typeof config;
