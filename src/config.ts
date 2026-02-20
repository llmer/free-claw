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
  chromeDebugPort: Number(process.env.CHROME_DEBUG_PORT) || 9222,
  chromeUserDataDir: expandHome(process.env.CHROME_USER_DATA_DIR?.trim() || "~/.free-claw/chrome-profile"),
  chromePath: process.env.CHROME_PATH?.trim() || "",
  chromeHeadless: process.env.CHROME_HEADLESS?.trim()?.toLowerCase() !== "false",
  maxBrowserTabs: Number(process.env.MAX_BROWSER_TABS) || 5,
  uploadsDir: expandHome(process.env.UPLOADS_DIR?.trim() || process.env.WORKSPACE_DIR?.trim() || "~/projects"),
} as const;

export type Config = typeof config;
