/**
 * Enhanced /jobs command Composer with inline keyboard controls.
 */

import { Composer, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import type { SchedulerService } from "../../scheduler/service.js";
import type { ScheduledJob } from "../../scheduler/types.js";

function formatScheduleType(job: ScheduledJob): string {
  if (job.schedule.kind === "at") return "one-time";
  if (job.schedule.kind === "cron") return `cron: ${job.schedule.expr}`;
  return `every ${Math.round(job.schedule.everyMs / 60_000)}m`;
}

function formatJobList(jobs: ScheduledJob[]): { text: string; keyboard: InlineKeyboard } {
  if (jobs.length === 0) {
    return {
      text: "No scheduled jobs.",
      keyboard: new InlineKeyboard(),
    };
  }

  const lines: string[] = ["Scheduled jobs:\n"];
  const kb = new InlineKeyboard();

  for (const job of jobs) {
    const id = job.id.slice(0, 8);
    const enabled = job.enabled ? "" : " [disabled]";
    const nextRun = job.state.nextRunAtMs
      ? new Date(job.state.nextRunAtMs).toLocaleString()
      : "none";
    const scheduleDesc = formatScheduleType(job);

    lines.push(`${id} | ${scheduleDesc}${enabled}`);
    lines.push(`  next: ${nextRun}`);
    lines.push(`  ${job.prompt.slice(0, 60)}`);
    lines.push("");

    // Action row per job
    const toggleLabel = job.enabled ? "Pause" : "Resume";
    const toggleEmoji = job.enabled ? "⏸" : "▶";
    kb.text(`▶ Run`, `job:run:${id}`)
      .text(`${toggleEmoji} ${toggleLabel}`, `job:tog:${id}`)
      .text("🗑 Delete", `job:del:${id}`)
      .text("ℹ Details", `job:det:${id}`)
      .row();
  }

  kb.text("🔄 Refresh", "job:ref");

  return { text: lines.join("\n"), keyboard: kb };
}

function formatJobDetails(job: ScheduledJob): string {
  const id = job.id.slice(0, 8);
  const lines = [
    `Job: ${id}`,
    `Status: ${job.enabled ? "enabled" : "disabled"}`,
    `Schedule: ${formatScheduleType(job)}`,
    `Prompt: ${job.prompt}`,
    "",
    `Created: ${job.createdAt}`,
    `Next run: ${job.state.nextRunAtMs ? new Date(job.state.nextRunAtMs).toLocaleString() : "none"}`,
    `Last run: ${job.state.lastRunAtMs ? new Date(job.state.lastRunAtMs).toLocaleString() : "never"}`,
    `Last status: ${job.state.lastStatus ?? "n/a"}`,
  ];

  if (job.state.lastError) {
    lines.push(`Last error: ${job.state.lastError.slice(0, 200)}`);
  }
  if (job.state.lastDurationMs) {
    lines.push(`Duration: ${(job.state.lastDurationMs / 1000).toFixed(1)}s`);
  }
  if (job.state.consecutiveErrors) {
    lines.push(`Consecutive errors: ${job.state.consecutiveErrors}`);
  }

  return lines.join("\n");
}

function findJob(scheduler: SchedulerService, chatId: number, idPrefix: string): ScheduledJob | undefined {
  return scheduler.listJobs(chatId).find((j) => j.id.startsWith(idPrefix));
}

export function createJobsComposer(scheduler: SchedulerService): Composer<Context> {
  const composer = new Composer<Context>();

  // /jobs command
  composer.command("jobs", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const jobs = scheduler.listJobs(chatId);
    const { text, keyboard } = formatJobList(jobs);
    await ctx.reply(text, { reply_markup: keyboard });
  });

  // Callback queries with job: prefix
  composer.callbackQuery(/^job:/, async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const data = ctx.callbackQuery.data;

    // --- List / Refresh ---
    if (data === "job:list" || data === "job:ref") {
      const jobs = scheduler.listJobs(chatId);
      const { text, keyboard } = formatJobList(jobs);
      await ctx.answerCallbackQuery();
      try {
        await ctx.editMessageText(text, { reply_markup: keyboard });
      } catch {
        await ctx.reply(text, { reply_markup: keyboard });
      }
      return;
    }

    // --- Run ---
    if (data.startsWith("job:run:")) {
      const idPrefix = data.slice("job:run:".length);
      const found = await scheduler.forceRunJob(chatId, idPrefix);
      if (found) {
        await ctx.answerCallbackQuery({ text: `Running job ${idPrefix}...` });
      } else {
        await ctx.answerCallbackQuery({ text: "Job not found." });
      }
      return;
    }

    // --- Toggle enable/disable ---
    if (data.startsWith("job:tog:")) {
      const idPrefix = data.slice("job:tog:".length);
      const job = findJob(scheduler, chatId, idPrefix);
      if (!job) {
        await ctx.answerCallbackQuery({ text: "Job not found." });
        return;
      }
      await scheduler.toggleJob(chatId, idPrefix);
      const newState = !job.enabled ? "enabled" : "disabled";
      await ctx.answerCallbackQuery({ text: `Job ${newState}.` });

      // Refresh the list
      const jobs = scheduler.listJobs(chatId);
      const { text, keyboard } = formatJobList(jobs);
      try {
        await ctx.editMessageText(text, { reply_markup: keyboard });
      } catch { /* ignore */ }
      return;
    }

    // --- Delete (confirmation) ---
    if (data.startsWith("job:del:")) {
      const idPrefix = data.slice("job:del:".length);
      const job = findJob(scheduler, chatId, idPrefix);
      if (!job) {
        await ctx.answerCallbackQuery({ text: "Job not found." });
        return;
      }
      await ctx.answerCallbackQuery();
      const kb = new InlineKeyboard()
        .text("Yes, delete", `job:dcy:${idPrefix}`)
        .text("Cancel", `job:dcn:${idPrefix}`);
      try {
        await ctx.editMessageText(
          `Delete job ${idPrefix}?\n\n${job.prompt.slice(0, 100)}`,
          { reply_markup: kb },
        );
      } catch {
        await ctx.reply(
          `Delete job ${idPrefix}?\n\n${job.prompt.slice(0, 100)}`,
          { reply_markup: kb },
        );
      }
      return;
    }

    // --- Delete confirm ---
    if (data.startsWith("job:dcy:")) {
      const idPrefix = data.slice("job:dcy:".length);
      const removed = await scheduler.removeJob(chatId, idPrefix);
      if (removed) {
        await ctx.answerCallbackQuery({ text: "Job deleted." });
      } else {
        await ctx.answerCallbackQuery({ text: "Job not found." });
      }
      // Refresh list
      const jobs = scheduler.listJobs(chatId);
      const { text, keyboard } = formatJobList(jobs);
      try {
        await ctx.editMessageText(text, { reply_markup: keyboard });
      } catch {
        await ctx.reply(text, { reply_markup: keyboard });
      }
      return;
    }

    // --- Delete cancel ---
    if (data.startsWith("job:dcn:")) {
      await ctx.answerCallbackQuery();
      const jobs = scheduler.listJobs(chatId);
      const { text, keyboard } = formatJobList(jobs);
      try {
        await ctx.editMessageText(text, { reply_markup: keyboard });
      } catch {
        await ctx.reply(text, { reply_markup: keyboard });
      }
      return;
    }

    // --- Details ---
    if (data.startsWith("job:det:")) {
      const idPrefix = data.slice("job:det:".length);
      const job = findJob(scheduler, chatId, idPrefix);
      if (!job) {
        await ctx.answerCallbackQuery({ text: "Job not found." });
        return;
      }
      await ctx.answerCallbackQuery();
      const details = formatJobDetails(job);
      const kb = new InlineKeyboard().text("« Back to list", "job:list");
      try {
        await ctx.editMessageText(details, { reply_markup: kb });
      } catch {
        await ctx.reply(details, { reply_markup: kb });
      }
      return;
    }

    await ctx.answerCallbackQuery();
  });

  return composer;
}
