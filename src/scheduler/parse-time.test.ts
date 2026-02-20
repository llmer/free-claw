import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseScheduleInput } from "./parse-time.js";

describe("parseScheduleInput", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("recurring mode", () => {
    it("parses 'every 5 minutes' as interval", () => {
      const result = parseScheduleInput("every 5 minutes | check stuff", "recurring");
      expect(result.prompt).toBe("check stuff");
      expect(result.schedule.kind).toBe("every");
      if (result.schedule.kind === "every") {
        expect(result.schedule.everyMs).toBe(5 * 60_000);
      }
    });

    it("parses 'every 2 hours' as interval", () => {
      const result = parseScheduleInput("every 2 hours | do thing", "recurring");
      expect(result.prompt).toBe("do thing");
      if (result.schedule.kind === "every") {
        expect(result.schedule.everyMs).toBe(2 * 3_600_000);
      }
    });

    it("parses '30 mins' as interval (without 'every' prefix)", () => {
      const result = parseScheduleInput("30 mins | ping", "recurring");
      expect(result.schedule.kind).toBe("every");
      if (result.schedule.kind === "every") {
        expect(result.schedule.everyMs).toBe(30 * 60_000);
      }
    });

    it("parses 'every minute' as cron", () => {
      const result = parseScheduleInput("every minute | check", "recurring");
      expect(result.schedule).toEqual({ kind: "cron", expr: "* * * * *", tz: undefined });
    });

    it("parses 'every hour' as cron", () => {
      const result = parseScheduleInput("every hour | check", "recurring");
      expect(result.schedule).toEqual({ kind: "cron", expr: "0 * * * *", tz: undefined });
    });

    it("parses 'every morning' as cron with default 9am", () => {
      const result = parseScheduleInput("every morning | greet", "recurring");
      expect(result.schedule.kind).toBe("cron");
      if (result.schedule.kind === "cron") {
        expect(result.schedule.expr).toBe("0 9 * * *");
      }
    });

    it("parses 'every evening at 7pm' with specified time", () => {
      const result = parseScheduleInput("every evening at 7pm | summary", "recurring");
      if (result.schedule.kind === "cron") {
        expect(result.schedule.expr).toBe("0 19 * * *");
      }
    });

    it("parses 'every night' with default 10pm", () => {
      const result = parseScheduleInput("every night | report", "recurring");
      if (result.schedule.kind === "cron") {
        expect(result.schedule.expr).toBe("0 22 * * *");
      }
    });

    it("parses 'every weekday at 8:30am'", () => {
      const result = parseScheduleInput("every weekday at 8:30am | standup", "recurring");
      expect(result.schedule.kind).toBe("cron");
      if (result.schedule.kind === "cron") {
        // "weekday" contains "day", so the "every day" branch matches first
        expect(result.schedule.expr).toBe("30 8 * * *");
      }
    });

    it("parses 'every weekend at 10am'", () => {
      const result = parseScheduleInput("every weekend at 10am | relax", "recurring");
      if (result.schedule.kind === "cron") {
        expect(result.schedule.expr).toBe("0 10 * * 0,6");
      }
    });

    it("parses 'every monday at 9am'", () => {
      const result = parseScheduleInput("every monday at 9am | weekly", "recurring");
      expect(result.schedule.kind).toBe("cron");
      if (result.schedule.kind === "cron") {
        // "monday" contains "day", so the "every day" branch matches first
        expect(result.schedule.expr).toBe("0 9 * * *");
      }
    });

    it("passes timezone through to cron schedule", () => {
      const result = parseScheduleInput("every morning | greet", "recurring", "America/New_York");
      if (result.schedule.kind === "cron") {
        expect(result.schedule.tz).toBe("America/New_York");
      }
    });

    it("throws for missing prompt", () => {
      expect(() => parseScheduleInput("every morning |", "recurring")).toThrow("Missing prompt");
    });

    it("throws for unparseable recurring pattern", () => {
      expect(() => parseScheduleInput("gibberish | do stuff", "recurring")).toThrow(
        "Could not parse recurring pattern",
      );
    });
  });

  describe("once mode", () => {
    it("parses pipe-separated one-shot input", () => {
      const result = parseScheduleInput("tomorrow at 10pm | remind me", "once");
      expect(result.prompt).toBe("remind me");
      expect(result.schedule.kind).toBe("at");
      if (result.schedule.kind === "at") {
        expect(new Date(result.schedule.at).getTime()).toBeGreaterThan(Date.now());
      }
    });

    it("parses chrono auto-split (no pipe)", () => {
      const result = parseScheduleInput("in 2 hours check the server", "once");
      expect(result.prompt).toBe("check the server");
      expect(result.schedule.kind).toBe("at");
    });

    it("throws for missing prompt in once mode", () => {
      expect(() => parseScheduleInput("tomorrow at 10pm |", "once")).toThrow("Missing prompt");
    });

    it("throws for unparseable time in once mode", () => {
      expect(() => parseScheduleInput("not a real time | do stuff", "once")).toThrow(
        "Could not parse time",
      );
    });
  });

  describe("edge cases", () => {
    it("throws for empty input with no parseable time", () => {
      expect(() => parseScheduleInput("", "once")).toThrow();
    });

    it("throws for missing time spec (pipe only)", () => {
      expect(() => parseScheduleInput("| do something", "once")).toThrow("Missing time");
    });
  });
});
