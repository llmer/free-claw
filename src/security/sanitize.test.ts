import { describe, it, expect } from "vitest";
import { sanitizeForPrompt } from "./sanitize.js";

describe("sanitizeForPrompt", () => {
  it("passes through normal ASCII text", () => {
    expect(sanitizeForPrompt("Hello, world!")).toBe("Hello, world!");
  });

  it("strips NUL bytes", () => {
    expect(sanitizeForPrompt("hello\x00world")).toBe("helloworld");
  });

  it("strips CR and LF characters", () => {
    expect(sanitizeForPrompt("line1\r\nline2\nline3")).toBe("line1line2line3");
  });

  it("strips zero-width chars and bidi marks", () => {
    // Zero-width space (U+200B), zero-width joiner (U+200D), LTR mark (U+200E)
    expect(sanitizeForPrompt("a\u200Bb\u200Dc\u200Ed")).toBe("abcd");
  });

  it("strips U+2028 and U+2029 separators", () => {
    expect(sanitizeForPrompt("a\u2028b\u2029c")).toBe("abc");
  });

  it("preserves visible Unicode (emoji, CJK)", () => {
    expect(sanitizeForPrompt("Hello 🌍 你好")).toBe("Hello 🌍 你好");
  });
});
