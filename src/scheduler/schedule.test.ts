import { describe, it, expect } from "vitest";
import { computeNextRunAtMs } from "./schedule.js";

describe("computeNextRunAtMs", () => {
  const NOW = new Date("2025-06-15T12:00:00Z").getTime();

  describe("kind: at", () => {
    it("returns ms for a future date", () => {
      const futureMs = NOW + 3_600_000;
      const result = computeNextRunAtMs({ kind: "at", at: new Date(futureMs).toISOString() }, NOW);
      expect(result).toBe(futureMs);
    });

    it("returns undefined for a past date", () => {
      const pastMs = NOW - 3_600_000;
      const result = computeNextRunAtMs({ kind: "at", at: new Date(pastMs).toISOString() }, NOW);
      expect(result).toBeUndefined();
    });

    it("returns undefined for invalid date", () => {
      const result = computeNextRunAtMs({ kind: "at", at: "not-a-date" }, NOW);
      expect(result).toBeUndefined();
    });
  });

  describe("kind: every", () => {
    it("returns anchor when now is before anchor", () => {
      const anchor = NOW + 5000;
      const result = computeNextRunAtMs({ kind: "every", everyMs: 60_000, anchorMs: anchor }, NOW);
      expect(result).toBe(anchor);
    });

    it("returns next interval boundary after now", () => {
      const anchor = NOW - 90_000; // 1.5 intervals ago (60s intervals)
      const result = computeNextRunAtMs({ kind: "every", everyMs: 60_000, anchorMs: anchor }, NOW);
      // anchor + 2*60000 = NOW - 90000 + 120000 = NOW + 30000
      expect(result).toBe(anchor + 2 * 60_000);
    });

    it("returns current boundary when exactly at a boundary", () => {
      const anchor = NOW - 120_000; // exactly 2 intervals ago
      const result = computeNextRunAtMs({ kind: "every", everyMs: 60_000, anchorMs: anchor }, NOW);
      // ceil division: (120000 + 60000 - 1) / 60000 = 2 steps → anchor + 2*60000 = NOW
      expect(result).toBe(NOW);
    });

    it("handles missing anchorMs (defaults to nowMs)", () => {
      const result = computeNextRunAtMs({ kind: "every", everyMs: 60_000 }, NOW);
      expect(result).toBeDefined();
      expect(result!).toBeGreaterThan(NOW);
    });
  });

  describe("kind: cron", () => {
    it("returns next run for standard cron expression", () => {
      // Every hour at minute 0
      const result = computeNextRunAtMs({ kind: "cron", expr: "0 * * * *" }, NOW);
      expect(result).toBeDefined();
      expect(result!).toBeGreaterThan(NOW);
    });

    it("returns undefined for empty cron expression", () => {
      const result = computeNextRunAtMs({ kind: "cron", expr: "" }, NOW);
      expect(result).toBeUndefined();
    });

    it("returns undefined for whitespace-only cron expression", () => {
      const result = computeNextRunAtMs({ kind: "cron", expr: "   " }, NOW);
      expect(result).toBeUndefined();
    });
  });
});
