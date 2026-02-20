import { describe, it, expect } from "vitest";
import { parseStreamLine, assembleStreamResult, type StreamEvent } from "./stream-parser.js";

describe("parseStreamLine", () => {
  it("returns null for empty string", () => {
    expect(parseStreamLine("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(parseStreamLine("   \n  ")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseStreamLine("not json")).toBeNull();
  });

  it("returns null for JSON primitive", () => {
    expect(parseStreamLine('"just a string"')).toBeNull();
  });

  it("returns null for unknown type", () => {
    expect(parseStreamLine('{"type":"unknown","data":"stuff"}')).toBeNull();
  });

  it("extracts session_id from system init", () => {
    const line = JSON.stringify({ type: "system", session_id: "abc-123" });
    expect(parseStreamLine(line)).toEqual({ type: "session", sessionId: "abc-123" });
  });

  it("extracts text from assistant old format (subtype text)", () => {
    const line = JSON.stringify({ type: "assistant", subtype: "text", text: "hello world" });
    expect(parseStreamLine(line)).toEqual({ type: "text", text: "hello world" });
  });

  it("returns null for assistant old format with empty text", () => {
    const line = JSON.stringify({ type: "assistant", subtype: "text", text: "" });
    expect(parseStreamLine(line)).toBeNull();
  });

  it("extracts text from assistant new format (content array)", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "new format text" }] },
    });
    expect(parseStreamLine(line)).toEqual({ type: "text", text: "new format text" });
  });

  it("concatenates multiple text blocks in content array", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "first " },
          { type: "text", text: "second" },
        ],
      },
    });
    expect(parseStreamLine(line)).toEqual({ type: "text", text: "first second" });
  });

  it("formats AskUserQuestion tool_use blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  header: "Choice",
                  question: "Which option?",
                  options: [{ label: "Option A" }, { label: "Option B" }],
                },
              ],
            },
          },
        ],
      },
    });
    const result = parseStreamLine(line);
    expect(result).toEqual({
      type: "text",
      text: "**Choice:** Which option?\n- Option A\n- Option B",
    });
  });

  it("returns empty text for non-AskUserQuestion tool_use", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "SomeOtherTool", input: {} }],
      },
    });
    expect(parseStreamLine(line)).toEqual({ type: "text", text: "" });
  });

  it("extracts text from content_block_delta", () => {
    const line = JSON.stringify({
      type: "content_block_delta",
      delta: { text: "delta chunk" },
    });
    expect(parseStreamLine(line)).toEqual({ type: "text", text: "delta chunk" });
  });

  it("returns null for content_block_delta with empty text", () => {
    const line = JSON.stringify({
      type: "content_block_delta",
      delta: { text: "" },
    });
    expect(parseStreamLine(line)).toBeNull();
  });

  it("extracts result with result field", () => {
    const line = JSON.stringify({
      type: "result",
      result: "final answer",
      session_id: "sess-1",
      duration_ms: 1234,
      cost_usd: 0.05,
    });
    expect(parseStreamLine(line)).toEqual({
      type: "result",
      text: "final answer",
      sessionId: "sess-1",
      durationMs: 1234,
      costUsd: 0.05,
    });
  });

  it("extracts result with text field fallback", () => {
    const line = JSON.stringify({ type: "result", text: "text fallback" });
    expect(parseStreamLine(line)).toEqual({
      type: "result",
      text: "text fallback",
      sessionId: undefined,
      durationMs: undefined,
      costUsd: undefined,
    });
  });

  it("extracts error result with is_error and errors array", () => {
    const line = JSON.stringify({
      type: "result",
      is_error: true,
      errors: ["bad thing", "another bad thing"],
    });
    expect(parseStreamLine(line)).toEqual({
      type: "error",
      error: "bad thing; another bad thing",
    });
  });

  it("extracts error event with error string", () => {
    const line = JSON.stringify({ type: "error", error: "something broke" });
    expect(parseStreamLine(line)).toEqual({ type: "error", error: "something broke" });
  });

  it("extracts error event with message fallback", () => {
    const line = JSON.stringify({ type: "error", message: "msg fallback" });
    expect(parseStreamLine(line)).toEqual({ type: "error", error: "msg fallback" });
  });

  it("returns unknown error for error event with no message", () => {
    const line = JSON.stringify({ type: "error" });
    expect(parseStreamLine(line)).toEqual({ type: "error", error: "Unknown error" });
  });

  it("returns empty text for user messages", () => {
    const line = JSON.stringify({ type: "user", message: { content: [] } });
    expect(parseStreamLine(line)).toEqual({ type: "text", text: "" });
  });
});

describe("assembleStreamResult", () => {
  it("concatenates text events", () => {
    const events: StreamEvent[] = [
      { type: "text", text: "hello " },
      { type: "text", text: "world" },
    ];
    expect(assembleStreamResult(events)).toEqual({ text: "hello world", sessionId: undefined });
  });

  it("adopts session ID from session event", () => {
    const events: StreamEvent[] = [
      { type: "session", sessionId: "s1" },
      { type: "text", text: "hi" },
    ];
    expect(assembleStreamResult(events)).toEqual({ text: "hi", sessionId: "s1" });
  });

  it("prefers result text when available", () => {
    const events: StreamEvent[] = [
      { type: "session", sessionId: "s1" },
      { type: "text", text: "streamed " },
      { type: "text", text: "text" },
      { type: "result", text: "final result", sessionId: "s2" },
    ];
    expect(assembleStreamResult(events)).toEqual({ text: "final result", sessionId: "s1" });
  });

  it("falls back to concatenated text when result text is empty", () => {
    const events: StreamEvent[] = [
      { type: "text", text: "a" },
      { type: "text", text: "b" },
      { type: "result", text: "", sessionId: "s1" },
    ];
    expect(assembleStreamResult(events)).toEqual({ text: "ab", sessionId: "s1" });
  });

  it("adopts sessionId from result if no session event", () => {
    const events: StreamEvent[] = [
      { type: "text", text: "x" },
      { type: "result", text: "", sessionId: "from-result" },
    ];
    expect(assembleStreamResult(events)).toEqual({ text: "x", sessionId: "from-result" });
  });
});
