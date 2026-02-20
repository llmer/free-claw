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

export type InboxEntry = {
  action: "create";
  name?: string;
  prompt: string;
  schedule: string;
  expiresAt?: string;
};

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
  return e.action === "create"
    && typeof e.prompt === "string" && e.prompt.trim() !== ""
    && typeof e.schedule === "string" && e.schedule.trim() !== "";
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
      if (entry.expiresAt) {
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
