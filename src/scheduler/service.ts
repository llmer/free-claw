/**
 * SchedulerService — timer loop, job lifecycle, CRUD.
 * Adapted from openclaw/src/cron/service/timer.ts.
 */

import crypto from "node:crypto";
import { config } from "../config.js";
import { computeNextRunAtMs } from "./schedule.js";
import { parseScheduleInput } from "./parse-time.js";
import { loadSchedulerStore, saveSchedulerStore } from "./store.js";
import { executeScheduledJob, type ExecutorDeps } from "./executor.js";
import type { ScheduledJob, SchedulerStoreFile } from "./types.js";

const MAX_TIMER_DELAY_MS = 60_000;
const MIN_REFIRE_GAP_MS = 2_000;
const STUCK_RUN_TIMEOUT_MS = 2 * 3_600_000; // 2 hours

/** Exponential backoff delays indexed by consecutive error count. */
const ERROR_BACKOFF_MS = [
  30_000,       // 1st error →  30s
  60_000,       // 2nd error →   1m
  5 * 60_000,   // 3rd error →   5m
  15 * 60_000,  // 4th error →  15m
  60 * 60_000,  // 5th+ error → 60m
];

function errorBackoffMs(consecutiveErrors: number): number {
  const idx = Math.min(consecutiveErrors - 1, ERROR_BACKOFF_MS.length - 1);
  return ERROR_BACKOFF_MS[Math.max(0, idx)];
}

export class SchedulerService {
  private store: SchedulerStoreFile = { version: 1, jobs: [], timezones: {} };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private deps: ExecutorDeps;
  private started = false;

  constructor(deps: ExecutorDeps) {
    this.deps = deps;
  }

  /**
   * Start the scheduler. Loads store, recovers from missed jobs, arms timer.
   */
  async start(): Promise<void> {
    this.store = await loadSchedulerStore();
    this.started = true;

    // Clear stale runningAtMs markers (stuck-run detection)
    const now = Date.now();
    for (const job of this.store.jobs) {
      if (typeof job.state.runningAtMs === "number") {
        if (now - job.state.runningAtMs > STUCK_RUN_TIMEOUT_MS) {
          console.warn(`[scheduler] Clearing stale runningAtMs for job ${job.id}`);
          job.state.runningAtMs = undefined;
        }
      }
    }

    // Recompute nextRunAtMs for enabled jobs that need it
    for (const job of this.store.jobs) {
      if (job.enabled && job.state.nextRunAtMs === undefined) {
        job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, now);
      }
    }

    await this.persist();

    // Check for missed jobs
    await this.runMissedJobs();

    this.armTimer();
    console.log(`[scheduler] Started with ${this.store.jobs.length} jobs`);
  }

  /**
   * Stop the scheduler.
   */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.started = false;
    console.log("[scheduler] Stopped");
  }

  /**
   * Create a job from natural language input.
   */
  async createFromNaturalLanguage(
    chatId: number,
    input: string,
    mode: "once" | "recurring",
  ): Promise<ScheduledJob> {
    const tz = this.getTimezone(chatId);
    const { schedule, prompt } = parseScheduleInput(input, mode, tz);

    const now = Date.now();
    const job: ScheduledJob = {
      id: crypto.randomUUID(),
      name: prompt.slice(0, 50) + (prompt.length > 50 ? "..." : ""),
      chatId,
      workDir: config.workspaceDir,
      prompt,
      schedule,
      enabled: true,
      deleteAfterRun: mode === "once",
      createdAt: new Date().toISOString(),
      userTimezone: tz,
      state: {
        nextRunAtMs: computeNextRunAtMs(schedule, now),
      },
    };

    this.store.jobs.push(job);
    await this.persist();
    this.armTimer();

    return job;
  }

  /**
   * List jobs for a specific chat (or all if chatId is undefined).
   */
  listJobs(chatId?: number): ScheduledJob[] {
    if (chatId === undefined) return [...this.store.jobs];
    return this.store.jobs.filter((j) => j.chatId === chatId);
  }

  /**
   * Remove a job by prefix match on ID.
   */
  async removeJob(chatId: number, idPrefix: string): Promise<boolean> {
    const idx = this.store.jobs.findIndex(
      (j) => j.chatId === chatId && j.id.startsWith(idPrefix),
    );
    if (idx < 0) return false;
    this.store.jobs.splice(idx, 1);
    await this.persist();
    this.armTimer();
    return true;
  }

  /**
   * Force-run a job immediately.
   */
  async forceRunJob(chatId: number, idPrefix: string): Promise<boolean> {
    const job = this.store.jobs.find(
      (j) => j.chatId === chatId && j.id.startsWith(idPrefix),
    );
    if (!job) return false;

    // Fire it asynchronously
    void this.executeJob(job);
    return true;
  }

  /**
   * Get timezone for a chat.
   */
  getTimezone(chatId: number): string {
    return this.store.timezones?.[String(chatId)] ?? config.defaultTimezone;
  }

  /**
   * Set timezone for a chat.
   */
  async setTimezone(chatId: number, tz: string): Promise<void> {
    if (!this.store.timezones) this.store.timezones = {};
    this.store.timezones[String(chatId)] = tz;
    await this.persist();
  }

  // --- Internal ---

  private armTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (!this.started) return;

    const nextAt = this.nextWakeAtMs();
    if (nextAt === undefined) return;

    const now = Date.now();
    const delay = Math.max(nextAt - now, 0);
    const clampedDelay = Math.min(delay, MAX_TIMER_DELAY_MS);

    this.timer = setTimeout(() => {
      void this.onTimer().catch((err) => {
        console.error("[scheduler] Timer tick failed:", err);
      });
    }, clampedDelay);
  }

  private nextWakeAtMs(): number | undefined {
    let earliest: number | undefined;
    for (const job of this.store.jobs) {
      if (!job.enabled) continue;
      const next = job.state.nextRunAtMs;
      if (typeof next === "number" && (earliest === undefined || next < earliest)) {
        earliest = next;
      }
    }
    return earliest;
  }

  private async onTimer(): Promise<void> {
    if (this.running) {
      // Re-arm to keep ticking
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        void this.onTimer().catch((err) => {
          console.error("[scheduler] Timer tick failed:", err);
        });
      }, MAX_TIMER_DELAY_MS);
      return;
    }

    this.running = true;
    try {
      const now = Date.now();
      const dueJobs = this.findDueJobs(now);

      if (dueJobs.length === 0) {
        return;
      }

      // Mark jobs as running
      for (const job of dueJobs) {
        job.state.runningAtMs = now;
        job.state.lastError = undefined;
      }
      await this.persist();

      // Execute due jobs sequentially
      for (const job of dueJobs) {
        await this.executeJob(job);
      }
    } finally {
      this.running = false;
      this.armTimer();
    }
  }

  private findDueJobs(nowMs: number): ScheduledJob[] {
    return this.store.jobs.filter((job) => {
      if (!job.enabled) return false;
      if (typeof job.state.runningAtMs === "number") return false;
      const next = job.state.nextRunAtMs;
      return typeof next === "number" && nowMs >= next;
    });
  }

  private async executeJob(job: ScheduledJob): Promise<void> {
    const startedAt = Date.now();
    job.state.runningAtMs = startedAt;
    job.state.lastError = undefined;

    let status: "ok" | "error" = "ok";
    let error: string | undefined;

    try {
      const result = await executeScheduledJob(job, this.deps);
      status = result.status;
      error = result.error;
    } catch (err) {
      status = "error";
      error = err instanceof Error ? err.message : String(err);
    }

    const endedAt = Date.now();
    this.applyJobResult(job, { status, error, startedAt, endedAt });

    // Check if job should be deleted
    const shouldDelete =
      job.schedule.kind === "at" && job.deleteAfterRun && status === "ok";

    if (shouldDelete) {
      this.store.jobs = this.store.jobs.filter((j) => j.id !== job.id);
      console.log(`[scheduler] Deleted one-shot job ${job.id}`);
    }

    await this.persist();
  }

  private applyJobResult(
    job: ScheduledJob,
    result: { status: "ok" | "error"; error?: string; startedAt: number; endedAt: number },
  ): void {
    job.state.runningAtMs = undefined;
    job.state.lastRunAtMs = result.startedAt;
    job.state.lastStatus = result.status;
    job.state.lastDurationMs = Math.max(0, result.endedAt - result.startedAt);
    job.state.lastError = result.error;

    if (result.status === "error") {
      job.state.consecutiveErrors = (job.state.consecutiveErrors ?? 0) + 1;
    } else {
      job.state.consecutiveErrors = 0;
    }

    if (job.schedule.kind === "at") {
      // One-shot jobs are always disabled after any terminal status
      job.enabled = false;
      job.state.nextRunAtMs = undefined;
    } else if (result.status === "error" && job.enabled) {
      // Apply exponential backoff
      const backoff = errorBackoffMs(job.state.consecutiveErrors ?? 1);
      const normalNext = computeNextRunAtMs(job.schedule, result.endedAt);
      const backoffNext = result.endedAt + backoff;
      job.state.nextRunAtMs =
        normalNext !== undefined ? Math.max(normalNext, backoffNext) : backoffNext;
      console.log(
        `[scheduler] Job ${job.id}: backoff ${backoff}ms, next at ${job.state.nextRunAtMs}`,
      );
    } else if (job.enabled) {
      const naturalNext = computeNextRunAtMs(job.schedule, result.endedAt);
      if (job.schedule.kind === "cron") {
        const minNext = result.endedAt + MIN_REFIRE_GAP_MS;
        job.state.nextRunAtMs =
          naturalNext !== undefined ? Math.max(naturalNext, minNext) : minNext;
      } else {
        job.state.nextRunAtMs = naturalNext;
      }
    } else {
      job.state.nextRunAtMs = undefined;
    }
  }

  private async runMissedJobs(): Promise<void> {
    const now = Date.now();
    const missed = this.store.jobs.filter((job) => {
      if (!job.enabled) return false;
      if (typeof job.state.runningAtMs === "number") return false;
      // Skip at-jobs that already ran
      if (job.schedule.kind === "at" && job.state.lastStatus) return false;
      const next = job.state.nextRunAtMs;
      return typeof next === "number" && now >= next;
    });

    if (missed.length > 0) {
      console.log(`[scheduler] Running ${missed.length} missed jobs after restart`);
      for (const job of missed) {
        await this.executeJob(job);
      }
    }
  }

  private async persist(): Promise<void> {
    await saveSchedulerStore(this.store);
  }
}
