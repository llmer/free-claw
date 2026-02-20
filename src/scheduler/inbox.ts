/**
 * Inbox processor — reads .scheduler-inbox.json written by Claude agent,
 * creates scheduler jobs, sends confirmations, and deletes the inbox file.
 */

import fs from "node:fs/promises";
import path from "node:path";
import * as chrono from "chrono-node";
import type { Bot } from "grammy";
import { parseRecurringPattern } from "./parse-time.js";
import type { SchedulerService } from "./service.js";
import type { CronSchedule } from "./types.js";

export type InboxEntry =
  | { action: "create"; name?: string; prompt: string; schedule: string; expiresAt?: string; duration?: string }
  | { action: "delete"; name: string }
  | { action: "disable"; name: string };

function looksRecurring(schedule: string): boolean {
  const s = schedule.toLowerCase();
  return /^every\b/.test(s) || /\bmorning\b/.test(s) || /\bevening\b/.test(s) || /\bnight\b/.test(s)
    || /\bdaily\b/.test(s) || /\bweekday\b/.test(s) || /\bweekend\b/.test(s);
}

function parseExpiresAt(raw: string): Date | null {
  // Try ISO date first
  const iso = new Date(raw);
  if (!Number.isNaN(iso.getTime())) return iso;

  // Fall back to chrono-node natural language
  const parsed = chrono.parseDate(raw, new Date(), { forwardDate: true });
  return parsed ?? null;
}

const DURATION_RE = /^\s*(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)\s*$/i;

const DURATION_MULTIPLIERS: Record<string, number> = {
  s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  w: 604_800_000, week: 604_800_000, weeks: 604_800_000,
};

/**
 * Parse a human-readable duration string (e.g., "5 minutes", "2 hours") into milliseconds.
 * Returns null if the string cannot be parsed.
 */
export function parseDuration(raw: string): number | null {
  const match = raw.match(DURATION_RE);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multiplier = DURATION_MULTIPLIERS[unit];
  if (!multiplier || value <= 0) return null;
  return value * multiplier;
}

function parseSchedule(scheduleStr: string, tz?: string): CronSchedule | null {
  if (looksRecurring(scheduleStr)) {
    return parseRecurringPattern(scheduleStr, tz);
  }

  // One-shot: parse with chrono-node
  const parsed = chrono.parseDate(scheduleStr, new Date(), { forwardDate: true });
  if (parsed) {
    return { kind: "at", at: parsed.toISOString() };
  }

  return null;
}

function validateEntry(entry: unknown): entry is InboxEntry {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Record<string, unknown>;

  if (e.action === "delete" || e.action === "disable") {
    return typeof e.name === "string" && e.name.trim() !== "";
  }

  if (e.action !== "create") return false;
  if (typeof e.prompt !== "string" || e.prompt.trim() === "") return false;
  if (typeof e.schedule !== "string" || e.schedule.trim() === "") return false;
  if (e.duration !== undefined && typeof e.duration !== "string") return false;
  return true;
}

/**
 * Process the scheduler inbox file for a given chat.
 * Reads, validates, creates jobs, sends confirmations, and deletes the file.
 * Never throws — all errors are caught and logged.
 */
export async function processInbox(
  chatId: number,
  workDir: string,
  scheduler: SchedulerService,
  api: Bot["api"],
): Promise<void> {
  const inboxPath = path.join(workDir, ".scheduler-inbox.json");

  let raw: string;
  try {
    raw = await fs.readFile(inboxPath, "utf-8");
  } catch {
    // File doesn't exist — common case, return silently
    return;
  }

  let entries: unknown[];
  try {
    const parsed = JSON.parse(raw);
    entries = Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    console.warn("[inbox] Failed to parse inbox JSON:", err);
    // Delete malformed file so it doesn't block future runs
    await fs.unlink(inboxPath).catch(() => {});
    return;
  }

  for (const entry of entries) {
    try {
      if (!validateEntry(entry)) {
        console.warn("[inbox] Skipping invalid entry:", JSON.stringify(entry));
        continue;
      }

      if (entry.action === "delete") {
        const removed = await scheduler.removeJobByName(chatId, entry.name);
        if (removed) {
          await api.sendMessage(chatId, `Deleted scheduled task: "${removed.name}"`).catch(() => {});
        } else {
          await api.sendMessage(chatId, `No scheduled task found matching "${entry.name}".`).catch(() => {});
        }
        continue;
      }

      if (entry.action === "disable") {
        const disabled = await scheduler.disableJobByName(chatId, entry.name);
        if (disabled) {
          await api.sendMessage(chatId, `Disabled scheduled task: "${disabled.name}"`).catch(() => {});
        } else {
          await api.sendMessage(chatId, `No scheduled task found matching "${entry.name}".`).catch(() => {});
        }
        continue;
      }

      const tz = scheduler.getTimezone(chatId);
      const schedule = parseSchedule(entry.schedule, tz);
      if (!schedule) {
        console.warn(`[inbox] Could not parse schedule: "${entry.schedule}"`);
        await api.sendMessage(chatId,
          `Could not parse schedule: "${entry.schedule}" — skipping.`,
        ).catch(() => {});
        continue;
      }

      let expiresAt: string | undefined;
      if (entry.duration) {
        const durationMs = parseDuration(entry.duration);
        if (durationMs) {
          expiresAt = new Date(Date.now() + durationMs).toISOString();
        } else {
          console.warn(`[inbox] Could not parse duration: "${entry.duration}"`);
        }
      }
      if (!expiresAt && entry.expiresAt) {
        const parsed = parseExpiresAt(entry.expiresAt);
        if (!parsed) {
          console.warn(`[inbox] Could not parse expiresAt: "${entry.expiresAt}"`);
        } else if (parsed.getTime() <= Date.now()) {
          console.warn(`[inbox] expiresAt is in the past: "${entry.expiresAt}" — skipping`);
          await api.sendMessage(chatId,
            `Skipped "${entry.name ?? entry.prompt.slice(0, 50)}" — expiry date is in the past.`,
          ).catch(() => {});
          continue;
        } else {
          expiresAt = parsed.toISOString();
        }
      }

      const mode = looksRecurring(entry.schedule) ? "recurring" : "once";
      const job = await scheduler.createJobFromInbox(chatId, {
        name: entry.name ?? entry.prompt.slice(0, 50) + (entry.prompt.length > 50 ? "..." : ""),
        prompt: entry.prompt,
        schedule,
        mode,
        expiresAt,
      });

      // Build confirmation message
      const expiresSuffix = expiresAt
        ? ` (expires ${new Date(expiresAt).toLocaleDateString()})`
        : "";
      const scheduleDesc = mode === "recurring"
        ? entry.schedule
        : `once at ${new Date(job.state.nextRunAtMs ?? 0).toLocaleString()}`;

      await api.sendMessage(chatId,
        `Scheduled: "${job.name}" — ${scheduleDesc}${expiresSuffix}`,
      ).catch(() => {});

    } catch (err) {
      console.warn("[inbox] Error processing entry:", err);
    }
  }

  // Always delete inbox file after processing
  await fs.unlink(inboxPath).catch(() => {});
}
