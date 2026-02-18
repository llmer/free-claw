import type { Context } from "grammy";
import { newSession, cancelChat, getStatus } from "../session/manager.js";
import type { SchedulerService } from "../scheduler/service.js";

/**
 * Register all bot commands.
 * Scheduler commands are in a separate function since the scheduler may not be initialized yet.
 */

export async function handleStart(ctx: Context): Promise<void> {
  await ctx.reply(
    "Hello! I'm your async Claude Code bot.\n\n" +
    "Send me any message and I'll forward it to Claude Code.\n\n" +
    "Commands:\n" +
    "/new — start a fresh conversation\n" +
    "/cancel — cancel the running task\n" +
    "/status — check session status\n" +
    "/schedule <time> | <prompt> — one-off scheduled task\n" +
    "/every <pattern> | <prompt> — recurring scheduled task\n" +
    "/jobs — list scheduled jobs\n" +
    "/canceljob <id> — cancel a scheduled job\n" +
    "/runjob <id> — force-run a job now\n" +
    "/timezone <tz> — set your timezone",
  );
}

export async function handleNew(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const session = await newSession(chatId);
  await ctx.reply(`New session started. Session ID: ${session.sessionId.slice(0, 8)}...`);
}

export async function handleCancel(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const killed = await cancelChat(chatId);
  if (killed) {
    await ctx.reply("Task cancelled.");
  } else {
    await ctx.reply("No running task to cancel.");
  }
}

export async function handleStatus(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const status = await getStatus(chatId);
  if (!status.hasSession) {
    await ctx.reply("No active session. Send a message to start one.");
    return;
  }

  const s = status.session!;
  const lines = [
    `Session: ${s.sessionId.slice(0, 8)}...`,
    `Status: ${s.status}${status.isRunning ? " (process running)" : ""}`,
    `Messages: ${s.messageCount}`,
    `Last activity: ${s.lastMessageAt}`,
    `Workspace: ${s.workDir}`,
  ];
  await ctx.reply(lines.join("\n"));
}

// --- Scheduler commands ---

export function handleSchedule(scheduler: SchedulerService) {
  return async (ctx: Context): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const text = ctx.message?.text?.replace(/^\/schedule\s*/, "").trim();
    if (!text) {
      await ctx.reply("Usage: /schedule <time> | <prompt>\nExample: /schedule tomorrow at 10pm | check the deployment");
      return;
    }

    try {
      const job = await scheduler.createFromNaturalLanguage(chatId, text, "once");
      await ctx.reply(
        `Scheduled! Job ${job.id.slice(0, 8)}\n` +
        `Next run: ${job.state.nextRunAtMs ? new Date(job.state.nextRunAtMs).toLocaleString() : "pending"}`,
      );
    } catch (err) {
      await ctx.reply(`Failed to schedule: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

export function handleEvery(scheduler: SchedulerService) {
  return async (ctx: Context): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const text = ctx.message?.text?.replace(/^\/every\s*/, "").trim();
    if (!text) {
      await ctx.reply("Usage: /every <pattern> | <prompt>\nExample: /every morning at 9am | check my emails");
      return;
    }

    try {
      const job = await scheduler.createFromNaturalLanguage(chatId, text, "recurring");
      await ctx.reply(
        `Recurring job created! Job ${job.id.slice(0, 8)}\n` +
        `Next run: ${job.state.nextRunAtMs ? new Date(job.state.nextRunAtMs).toLocaleString() : "pending"}`,
      );
    } catch (err) {
      await ctx.reply(`Failed to create recurring job: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

export function handleJobs(scheduler: SchedulerService) {
  return async (ctx: Context): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const jobs = scheduler.listJobs(chatId);
    if (jobs.length === 0) {
      await ctx.reply("No scheduled jobs.");
      return;
    }

    const lines = jobs.map((job) => {
      const id = job.id.slice(0, 8);
      const enabled = job.enabled ? "" : " [disabled]";
      const nextRun = job.state.nextRunAtMs
        ? new Date(job.state.nextRunAtMs).toLocaleString()
        : "none";
      const scheduleDesc = job.schedule.kind === "at"
        ? "one-time"
        : job.schedule.kind === "cron"
          ? `cron: ${job.schedule.expr}`
          : `every ${Math.round(job.schedule.everyMs / 60_000)}m`;
      return `${id} | ${scheduleDesc}${enabled} | next: ${nextRun}\n  → ${job.prompt.slice(0, 60)}`;
    });

    await ctx.reply(`Scheduled jobs:\n\n${lines.join("\n\n")}`);
  };
}

export function handleCancelJob(scheduler: SchedulerService) {
  return async (ctx: Context): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const idPrefix = ctx.message?.text?.replace(/^\/canceljob\s*/, "").trim();
    if (!idPrefix) {
      await ctx.reply("Usage: /canceljob <id-prefix>");
      return;
    }

    const removed = await scheduler.removeJob(chatId, idPrefix);
    if (removed) {
      await ctx.reply(`Job ${idPrefix} cancelled.`);
    } else {
      await ctx.reply(`No job found matching "${idPrefix}".`);
    }
  };
}

export function handleRunJob(scheduler: SchedulerService) {
  return async (ctx: Context): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const idPrefix = ctx.message?.text?.replace(/^\/runjob\s*/, "").trim();
    if (!idPrefix) {
      await ctx.reply("Usage: /runjob <id-prefix>");
      return;
    }

    const found = await scheduler.forceRunJob(chatId, idPrefix);
    if (found) {
      await ctx.reply(`Running job ${idPrefix} now...`);
    } else {
      await ctx.reply(`No job found matching "${idPrefix}".`);
    }
  };
}

export function handleTimezone(scheduler: SchedulerService) {
  return async (ctx: Context): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const tz = ctx.message?.text?.replace(/^\/timezone\s*/, "").trim();
    if (!tz) {
      const current = scheduler.getTimezone(chatId);
      await ctx.reply(`Current timezone: ${current}\nUsage: /timezone America/New_York`);
      return;
    }

    // Validate timezone
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz });
    } catch {
      await ctx.reply(`Invalid timezone: "${tz}". Use IANA format, e.g., America/New_York`);
      return;
    }

    scheduler.setTimezone(chatId, tz);
    await ctx.reply(`Timezone set to: ${tz}`);
  };
}
