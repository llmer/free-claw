import { describe, it, expect } from "vitest";
import { chunkText } from "./streaming.js";

describe("chunkText", () => {
  it("returns single chunk for text under limit", () => {
    expect(chunkText("short text")).toEqual(["short text"]);
  });

  it("returns single chunk for text exactly at limit", () => {
    const text = "a".repeat(4096);
    expect(chunkText(text)).toEqual([text]);
  });

  it("splits text over limit into multiple chunks", () => {
    const text = "a".repeat(5000);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    // All content is preserved
    expect(chunks.join("")).toBe(text);
  });

  it("splits at newline when possible", () => {
    const line1 = "a".repeat(3000);
    const line2 = "b".repeat(3000);
    const text = `${line1}\n${line2}`;
    const chunks = chunkText(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(line1);
    expect(chunks[1]).toBe(line2);
  });

  it("falls back to space split when newline is too early", () => {
    // Newline at position 100 (< 50% of 4096), space at a good position
    const part1 = "a".repeat(100);
    const part2 = "b".repeat(3500);
    const part3 = "c".repeat(2000);
    const text = `${part1}\n${part2} ${part3}`;
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("hard splits when no good split point exists", () => {
    // One giant word with no spaces or newlines
    const text = "x".repeat(8000);
    const chunks = chunkText(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(4096);
  });

  it("trims leading whitespace on continuation chunks", () => {
    const line1 = "a".repeat(3000);
    const line2 = "b".repeat(3000);
    const text = `${line1}\n   ${line2}`;
    const chunks = chunkText(text);
    expect(chunks.length).toBe(2);
    // Second chunk should have leading whitespace trimmed
    expect(chunks[1]).toBe(line2);
  });

  it("respects custom maxLen", () => {
    const text = "a".repeat(100);
    const chunks = chunkText(text, 50);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(50);
    expect(chunks[1].length).toBe(50);
  });
});
