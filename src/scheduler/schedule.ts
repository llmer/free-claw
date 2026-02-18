/**
 * Schedule computation. Ported from openclaw/src/cron/schedule.ts.
 */

import { Cron } from "croner";
import type { CronSchedule } from "./types.js";

function resolveCronTimezone(tz?: string): string {
  const trimmed = typeof tz === "string" ? tz.trim() : "";
  if (trimmed) return trimmed;
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Compute the next run time in milliseconds for a given schedule.
 * Returns undefined if the schedule has no future run time.
 */
export function computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined {
  if (schedule.kind === "at") {
    const atMs = new Date(schedule.at).getTime();
    if (!Number.isFinite(atMs)) return undefined;
    return atMs > nowMs ? atMs : undefined;
  }

  if (schedule.kind === "every") {
    const everyMs = Math.max(1, Math.floor(schedule.everyMs));
    const anchor = Math.max(0, Math.floor(schedule.anchorMs ?? nowMs));
    if (nowMs < anchor) return anchor;
    const elapsed = nowMs - anchor;
    const steps = Math.max(1, Math.floor((elapsed + everyMs - 1) / everyMs));
    return anchor + steps * everyMs;
  }

  // kind === "cron"
  const expr = schedule.expr.trim();
  if (!expr) return undefined;

  const cron = new Cron(expr, {
    timezone: resolveCronTimezone(schedule.tz),
    catch: false,
  });

  const next = cron.nextRun(new Date(nowMs));
  if (!next) return undefined;

  const nextMs = next.getTime();
  if (!Number.isFinite(nextMs)) return undefined;
  if (nextMs > nowMs) return nextMs;

  // Guard against same-second rescheduling loops: if croner returns
  // "now" (or an earlier instant), retry from the next whole second.
  const nextSecondMs = Math.floor(nowMs / 1000) * 1000 + 1000;
  const retry = cron.nextRun(new Date(nextSecondMs));
  if (!retry) return undefined;

  const retryMs = retry.getTime();
  return Number.isFinite(retryMs) && retryMs > nowMs ? retryMs : undefined;
}
