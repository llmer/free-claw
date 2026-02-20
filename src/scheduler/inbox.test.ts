import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseDuration } from "./inbox.js";

describe("parseDuration", () => {
  it("parses seconds", () => {
    expect(parseDuration("30 seconds")).toBe(30_000);
    expect(parseDuration("1 second")).toBe(1_000);
    expect(parseDuration("10 s")).toBe(10_000);
    expect(parseDuration("5 sec")).toBe(5_000);
    expect(parseDuration("2 secs")).toBe(2_000);
  });

  it("parses minutes", () => {
    expect(parseDuration("5 minutes")).toBe(300_000);
    expect(parseDuration("1 minute")).toBe(60_000);
    expect(parseDuration("10 m")).toBe(600_000);
    expect(parseDuration("3 min")).toBe(180_000);
    expect(parseDuration("7 mins")).toBe(420_000);
  });

  it("parses hours", () => {
    expect(parseDuration("2 hours")).toBe(7_200_000);
    expect(parseDuration("1 hour")).toBe(3_600_000);
    expect(parseDuration("3 h")).toBe(10_800_000);
    expect(parseDuration("4 hr")).toBe(14_400_000);
    expect(parseDuration("6 hrs")).toBe(21_600_000);
  });

  it("parses days", () => {
    expect(parseDuration("3 days")).toBe(259_200_000);
    expect(parseDuration("1 day")).toBe(86_400_000);
    expect(parseDuration("2 d")).toBe(172_800_000);
  });

  it("parses weeks", () => {
    expect(parseDuration("1 week")).toBe(604_800_000);
    expect(parseDuration("2 weeks")).toBe(1_209_600_000);
    expect(parseDuration("1 w")).toBe(604_800_000);
  });

  it("is case-insensitive", () => {
    expect(parseDuration("5 Minutes")).toBe(300_000);
    expect(parseDuration("2 HOURS")).toBe(7_200_000);
  });

  it("handles leading/trailing whitespace", () => {
    expect(parseDuration("  5 minutes  ")).toBe(300_000);
  });

  it("returns null for invalid input", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("five minutes")).toBeNull();
    expect(parseDuration("minutes")).toBeNull();
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("0 minutes")).toBeNull();
    expect(parseDuration("-1 hours")).toBeNull();
  });
});

// --- processInbox integration tests ---

vi.mock("../config.js", () => ({
  config: {
    workspaceDir: "/workspace",
    defaultTimezone: "UTC",
  },
}));

import fs from "node:fs/promises";
import { processInbox } from "./inbox.js";

// Minimal mock for SchedulerService
function mockScheduler() {
  return {
    getTimezone: vi.fn().mockReturnValue("UTC"),
    createJobFromInbox: vi.fn().mockImplementation(async (_chatId: number, entry: Record<string, unknown>) => ({
      id: "job-1",
      name: entry.name,
      state: { nextRunAtMs: Date.now() + 60_000 },
    })),
    removeJobByName: vi.fn().mockResolvedValue(null),
    disableJobByName: vi.fn().mockResolvedValue(null),
  };
}

function mockApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue({}),
  };
}

describe("processInbox with duration", () => {
  const inboxPath = "/workspace/.scheduler-inbox.json";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    vi.spyOn(fs, "unlink").mockResolvedValue();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("computes expiresAt from duration field", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify([{
      action: "create",
      prompt: "ping me",
      schedule: "every 1 minute",
      duration: "5 minutes",
    }]));

    const scheduler = mockScheduler();
    const api = mockApi();
    await processInbox(123, "/workspace", scheduler as any, api as any);

    expect(scheduler.createJobFromInbox).toHaveBeenCalledOnce();
    const call = scheduler.createJobFromInbox.mock.calls[0];
    const expiresAt = call[1].expiresAt as string;
    const expiresDate = new Date(expiresAt);
    // Should be ~5 minutes from "now" (2026-01-15T12:00:00Z)
    expect(expiresDate.getTime()).toBe(new Date("2026-01-15T12:05:00Z").getTime());
  });

  it("duration takes precedence over expiresAt", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify([{
      action: "create",
      prompt: "ping me",
      schedule: "every 1 minute",
      duration: "10 minutes",
      expiresAt: "2026-12-31",
    }]));

    const scheduler = mockScheduler();
    const api = mockApi();
    await processInbox(123, "/workspace", scheduler as any, api as any);

    const call = scheduler.createJobFromInbox.mock.calls[0];
    const expiresAt = call[1].expiresAt as string;
    const expiresDate = new Date(expiresAt);
    // Should be 10 minutes from now, NOT the expiresAt date
    expect(expiresDate.getTime()).toBe(new Date("2026-01-15T12:10:00Z").getTime());
  });

  it("falls back to expiresAt when duration is invalid", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify([{
      action: "create",
      prompt: "ping me",
      schedule: "every 1 minute",
      duration: "not a duration",
      expiresAt: "2026-03-01",
    }]));

    const scheduler = mockScheduler();
    const api = mockApi();
    await processInbox(123, "/workspace", scheduler as any, api as any);

    const call = scheduler.createJobFromInbox.mock.calls[0];
    const expiresAt = call[1].expiresAt as string;
    const expiresDate = new Date(expiresAt);
    // Should come from the expiresAt field, not duration — just verify it's in 2026
    // and well beyond our "now" of 2026-01-15
    expect(expiresDate.getFullYear()).toBe(2026);
    expect(expiresDate.getTime()).toBeGreaterThan(new Date("2026-02-01").getTime());
  });

  it("validates duration field type", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify([{
      action: "create",
      prompt: "ping me",
      schedule: "every 1 minute",
      duration: 12345,
    }]));

    const scheduler = mockScheduler();
    const api = mockApi();
    await processInbox(123, "/workspace", scheduler as any, api as any);

    // Entry with non-string duration should be skipped by validation
    expect(scheduler.createJobFromInbox).not.toHaveBeenCalled();
  });
});

describe("processInbox with delete action", () => {
  beforeEach(() => {
    vi.spyOn(fs, "unlink").mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls removeJobByName and sends confirmation", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify([
      { action: "delete", name: "Sanity ping" },
    ]));

    const scheduler = mockScheduler();
    scheduler.removeJobByName.mockResolvedValue({ id: "job-1", name: "Sanity ping" });
    const api = mockApi();
    await processInbox(123, "/workspace", scheduler as any, api as any);

    expect(scheduler.removeJobByName).toHaveBeenCalledWith(123, "Sanity ping");
    expect(api.sendMessage).toHaveBeenCalledWith(123, 'Deleted scheduled task: "Sanity ping"');
  });

  it("sends not-found message when no job matches", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify([
      { action: "delete", name: "Nonexistent task" },
    ]));

    const scheduler = mockScheduler();
    const api = mockApi();
    await processInbox(123, "/workspace", scheduler as any, api as any);

    expect(scheduler.removeJobByName).toHaveBeenCalledWith(123, "Nonexistent task");
    expect(api.sendMessage).toHaveBeenCalledWith(123, 'No scheduled task found matching "Nonexistent task".');
  });
});

describe("processInbox with disable action", () => {
  beforeEach(() => {
    vi.spyOn(fs, "unlink").mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls disableJobByName and sends confirmation", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify([
      { action: "disable", name: "Morning report" },
    ]));

    const scheduler = mockScheduler();
    scheduler.disableJobByName.mockResolvedValue({ id: "job-2", name: "Morning report" });
    const api = mockApi();
    await processInbox(123, "/workspace", scheduler as any, api as any);

    expect(scheduler.disableJobByName).toHaveBeenCalledWith(123, "Morning report");
    expect(api.sendMessage).toHaveBeenCalledWith(123, 'Disabled scheduled task: "Morning report"');
  });

  it("sends not-found message when no job matches", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify([
      { action: "disable", name: "Nonexistent" },
    ]));

    const scheduler = mockScheduler();
    const api = mockApi();
    await processInbox(123, "/workspace", scheduler as any, api as any);

    expect(scheduler.disableJobByName).toHaveBeenCalledWith(123, "Nonexistent");
    expect(api.sendMessage).toHaveBeenCalledWith(123, 'No scheduled task found matching "Nonexistent".');
  });
});

describe("validateEntry for delete/disable", () => {
  // We test validateEntry indirectly through processInbox — invalid entries are skipped

  beforeEach(() => {
    vi.spyOn(fs, "unlink").mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects delete entry without name", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify([
      { action: "delete" },
    ]));

    const scheduler = mockScheduler();
    const api = mockApi();
    await processInbox(123, "/workspace", scheduler as any, api as any);

    expect(scheduler.removeJobByName).not.toHaveBeenCalled();
  });

  it("rejects delete entry with empty name", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify([
      { action: "delete", name: "  " },
    ]));

    const scheduler = mockScheduler();
    const api = mockApi();
    await processInbox(123, "/workspace", scheduler as any, api as any);

    expect(scheduler.removeJobByName).not.toHaveBeenCalled();
  });

  it("rejects disable entry with non-string name", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify([
      { action: "disable", name: 42 },
    ]));

    const scheduler = mockScheduler();
    const api = mockApi();
    await processInbox(123, "/workspace", scheduler as any, api as any);

    expect(scheduler.disableJobByName).not.toHaveBeenCalled();
  });

  it("rejects unknown action type", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify([
      { action: "pause", name: "test" },
    ]));

    const scheduler = mockScheduler();
    const api = mockApi();
    await processInbox(123, "/workspace", scheduler as any, api as any);

    expect(scheduler.removeJobByName).not.toHaveBeenCalled();
    expect(scheduler.disableJobByName).not.toHaveBeenCalled();
    expect(scheduler.createJobFromInbox).not.toHaveBeenCalled();
  });
});
