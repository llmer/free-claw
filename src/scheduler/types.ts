export type CronSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string };

export type ScheduledJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  lastDurationMs?: number;
  consecutiveErrors?: number;
};

export type ScheduledJob = {
  id: string;
  name: string;
  chatId: number;
  workDir: string;
  prompt: string;
  schedule: CronSchedule;
  enabled: boolean;
  deleteAfterRun: boolean;
  createdAt: string;
  userTimezone?: string;
  state: ScheduledJobState;
};

export type SchedulerStoreFile = {
  version: 1;
  jobs: ScheduledJob[];
  /** Per-chat timezone settings */
  timezones?: Record<string, string>;
};
