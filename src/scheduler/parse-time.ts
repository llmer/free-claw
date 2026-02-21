/**
 * Natural language time parsing.
 *
 * Layer 1: chrono-node for one-shot times ("tomorrow at 10pm", "in 2 hours")
 * Layer 2: Regex patterns for recurring schedules ("every morning at 9am", "every weekday at 8:30am")
 */

import * as chrono from "chrono-node";
import type { CronSchedule } from "./types.js";

/**
 * Parse a recurring pattern into a cron schedule.
 * Returns null if the pattern doesn't match any known recurring format.
 */
export function parseRecurringPattern(input: string, tz?: string): CronSchedule | null {
  const text = input.toLowerCase().trim();

  // "every N hours from Xam to Ypm" → windowed interval as cron hour list
  const windowMatch = text.match(
    /^every\s+(\d+)\s*(?:hours?|hrs?|h)\s+(?:from|between)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(?:to|and|until|-)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i,
  );
  if (windowMatch) {
    const step = parseInt(windowMatch[1], 10);
    let startHour = parseInt(windowMatch[2], 10);
    const startMinute = windowMatch[3] ? parseInt(windowMatch[3], 10) : 0;
    const startAmPm = windowMatch[4]?.toLowerCase();
    let endHour = parseInt(windowMatch[5], 10);
    const endAmPm = windowMatch[7]?.toLowerCase();

    if (startAmPm === "pm" && startHour < 12) startHour += 12;
    if (startAmPm === "am" && startHour === 12) startHour = 0;
    if (endAmPm === "pm" && endHour < 12) endHour += 12;
    if (endAmPm === "am" && endHour === 12) endHour = 0;

    if (startHour >= endHour) {
      throw new Error(
        `Invalid window: start hour (${startHour}) must be before end hour (${endHour})`,
      );
    }

    const hours: number[] = [];
    for (let h = startHour; h <= endHour; h += step) {
      hours.push(h);
    }
    if (hours.length === 0) hours.push(startHour);

    return { kind: "cron", expr: `${startMinute} ${hours.join(",")} * * *`, tz };
  }

  // "every N minutes/hours" → fixed interval
  const intervalMatch = text.match(
    /^(?:every\s+)?(\d+)\s*(minutes?|mins?|m|hours?|hrs?|h|seconds?|secs?|s)$/,
  );
  if (intervalMatch) {
    const n = parseInt(intervalMatch[1], 10);
    const unit = intervalMatch[2];
    let ms: number;
    if (unit.startsWith("s")) ms = n * 1000;
    else if (unit.startsWith("m")) ms = n * 60_000;
    else ms = n * 3_600_000;
    return { kind: "every", everyMs: ms, anchorMs: Date.now() };
  }

  // "every minute" / "every hour"
  if (/^(?:every\s+)?minute$/.test(text)) {
    return { kind: "cron", expr: "* * * * *", tz };
  }
  if (/^(?:every\s+)?hour$/.test(text)) {
    return { kind: "cron", expr: "0 * * * *", tz };
  }

  // Parse time component from the pattern
  const timeMatch = text.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  let hour: number | undefined;
  let minute = 0;
  if (timeMatch) {
    hour = parseInt(timeMatch[1], 10);
    minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const ampm = timeMatch[3]?.toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
  }

  // "every morning [at X]" → default 9:00
  if (/morning/.test(text)) {
    const h = hour ?? 9;
    return { kind: "cron", expr: `${minute} ${h} * * *`, tz };
  }

  // "every evening [at X]" → default 18:00
  if (/evening/.test(text)) {
    const h = hour ?? 18;
    return { kind: "cron", expr: `${minute} ${h} * * *`, tz };
  }

  // "every night [at X]" → default 22:00
  if (/night/.test(text)) {
    const h = hour ?? 22;
    return { kind: "cron", expr: `${minute} ${h} * * *`, tz };
  }

  // "every weekday at X" (must be before "day" check)
  if (/weekday/.test(text) && hour !== undefined) {
    return { kind: "cron", expr: `${minute} ${hour} * * 1-5`, tz };
  }

  // "every weekend at X"
  if (/weekend/.test(text) && hour !== undefined) {
    return { kind: "cron", expr: `${minute} ${hour} * * 0,6`, tz };
  }

  // "every Monday/Tuesday/... at X" (must be before "day" check)
  const dayNames: Record<string, string> = {
    sunday: "0", monday: "1", tuesday: "2", wednesday: "3",
    thursday: "4", friday: "5", saturday: "6",
    sun: "0", mon: "1", tue: "2", wed: "3",
    thu: "4", fri: "5", sat: "6",
  };
  for (const [name, dow] of Object.entries(dayNames)) {
    if (text.includes(name) && hour !== undefined) {
      return { kind: "cron", expr: `${minute} ${hour} * * ${dow}`, tz };
    }
  }

  // "every day at X" (after weekday/weekend/named-day checks)
  if (/(?:every\s+)?day/.test(text) && hour !== undefined) {
    return { kind: "cron", expr: `${minute} ${hour} * * *`, tz };
  }

  // If we have a time but no day pattern, treat as daily
  if (hour !== undefined) {
    return { kind: "cron", expr: `${minute} ${hour} * * *`, tz };
  }

  return null;
}

/**
 * Parse an input string containing time spec and prompt, separated by `|`.
 * Returns the schedule and the prompt.
 */
export function parseScheduleInput(
  input: string,
  mode: "once" | "recurring",
  tz?: string,
): { schedule: CronSchedule; prompt: string } {
  // Split on `|` — first part is time, second is prompt
  const pipeIdx = input.indexOf("|");
  let timeSpec: string;
  let prompt: string;

  if (pipeIdx >= 0) {
    timeSpec = input.slice(0, pipeIdx).trim();
    prompt = input.slice(pipeIdx + 1).trim();
  } else {
    // No pipe — try to parse with chrono-node and use the rest as prompt
    const parsed = chrono.parse(input, new Date(), { forwardDate: true });
    if (parsed.length > 0 && parsed[0].index !== undefined) {
      const match = parsed[0];
      const endIdx = match.index + match.text.length;
      timeSpec = input.slice(0, endIdx).trim();
      prompt = input.slice(endIdx).trim();
    } else {
      throw new Error("Could not parse time. Use format: <time> | <prompt>");
    }
  }

  if (!prompt) {
    throw new Error("Missing prompt after time specification. Use format: <time> | <prompt>");
  }

  if (!timeSpec) {
    throw new Error("Missing time specification. Use format: <time> | <prompt>");
  }

  let schedule: CronSchedule;

  if (mode === "recurring") {
    const recurring = parseRecurringPattern(timeSpec, tz);
    if (recurring) {
      schedule = recurring;
    } else {
      throw new Error(
        `Could not parse recurring pattern: "${timeSpec}". ` +
        `Try: "every morning at 9am", "every weekday at 8:30am", "every 30 minutes"`,
      );
    }
  } else {
    // One-shot schedule — parse with chrono-node
    const ref = new Date();
    const parsed = chrono.parseDate(timeSpec, ref, { forwardDate: true });
    if (!parsed) {
      throw new Error(
        `Could not parse time: "${timeSpec}". ` +
        `Try: "tomorrow at 10pm", "in 2 hours", "next Friday at 3pm"`,
      );
    }
    schedule = { kind: "at", at: parsed.toISOString() };
  }

  return { schedule, prompt };
}
