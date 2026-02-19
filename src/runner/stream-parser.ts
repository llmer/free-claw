/**
 * Parse NDJSON output from `claude --output-format stream-json`.
 *
 * Each line is a JSON object. We extract:
 * - assistant text (from "assistant" type messages with "text" subtype)
 * - result text (from the final "result" message)
 * - session_id (from "system" init or "result" messages)
 */

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "result"; text: string; sessionId?: string; durationMs?: number; costUsd?: number }
  | { type: "error"; error: string }
  | { type: "session"; sessionId: string };

/**
 * Extract readable text from an AskUserQuestion tool_use input.
 * Returns formatted questions with headers and option bullets, or null if invalid.
 */
function formatAskUserQuestions(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const inp = input as Record<string, unknown>;
  const questions = inp.questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;

  const parts: string[] = [];
  for (const q of questions) {
    if (!q || typeof q !== "object") continue;
    const qObj = q as Record<string, unknown>;
    const question = typeof qObj.question === "string" ? qObj.question : null;
    if (!question) continue;

    const header = typeof qObj.header === "string" ? qObj.header : null;
    parts.push(header ? `**${header}:** ${question}` : question);

    if (Array.isArray(qObj.options)) {
      for (const opt of qObj.options) {
        if (opt && typeof opt === "object") {
          const label = (opt as Record<string, unknown>).label;
          if (typeof label === "string") parts.push(`- ${label}`);
        }
      }
    }
  }

  return parts.length > 0 ? parts.join("\n") : null;
}

export function parseStreamLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;

  const type = parsed.type as string | undefined;

  // System init message carries session_id
  if (type === "system" && typeof parsed.session_id === "string") {
    return { type: "session", sessionId: parsed.session_id };
  }

  // Assistant text chunks — old format: { type: "assistant", subtype: "text", text: "..." }
  if (type === "assistant" && parsed.subtype === "text") {
    const text = typeof parsed.text === "string" ? parsed.text : "";
    if (text) return { type: "text", text };
  }

  // Assistant text chunks — new format: { type: "assistant", message: { content: [{ type: "text", text: "..." }] } }
  if (type === "assistant" && parsed.message && typeof parsed.message === "object") {
    const msg = parsed.message as Record<string, unknown>;
    if (Array.isArray(msg.content)) {
      const texts: string[] = [];
      for (const block of msg.content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "text") {
          const t = b.text;
          if (typeof t === "string") texts.push(t);
        } else if (b.type === "tool_use" && b.name === "AskUserQuestion") {
          const formatted = formatAskUserQuestions(b.input);
          if (formatted) texts.push(formatted);
        }
      }
      const combined = texts.join("");
      if (combined) return { type: "text", text: combined };
      // Content was processed but produced no text (e.g. non-AskUserQuestion tools)
      return { type: "text", text: "" };
    }
  }

  // Content block text (alternative format)
  if (type === "content_block_delta") {
    const delta = parsed.delta as Record<string, unknown> | undefined;
    if (delta && typeof delta.text === "string" && delta.text) {
      return { type: "text", text: delta.text };
    }
  }

  // Final result
  if (type === "result") {
    const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : undefined;
    const durationMs = typeof parsed.duration_ms === "number" ? parsed.duration_ms : undefined;
    const costUsd = typeof parsed.cost_usd === "number" ? parsed.cost_usd : undefined;

    // If this is an error result, extract from the errors array
    if (parsed.is_error && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      const errorMsg = parsed.errors.join("; ");
      return { type: "error", error: errorMsg };
    }

    // Extract result text from various possible shapes
    let text = "";
    if (typeof parsed.result === "string") {
      text = parsed.result;
    } else if (typeof parsed.text === "string") {
      text = parsed.text;
    }

    return { type: "result", text, sessionId, durationMs, costUsd };
  }

  // Error messages
  if (type === "error") {
    const error =
      typeof parsed.error === "string"
        ? parsed.error
        : typeof parsed.message === "string"
          ? parsed.message
          : "Unknown error";
    return { type: "error", error };
  }

  // User messages (tool_result responses from the CLI) — no useful content to surface
  if (type === "user") {
    return { type: "text", text: "" };
  }

  return null;
}

/**
 * Accumulate text from a stream of events, returning the final assembled output.
 */
export function assembleStreamResult(events: StreamEvent[]): {
  text: string;
  sessionId?: string;
} {
  const textParts: string[] = [];
  let sessionId: string | undefined;

  for (const event of events) {
    switch (event.type) {
      case "session":
        sessionId = event.sessionId;
        break;
      case "text":
        textParts.push(event.text);
        break;
      case "result":
        if (!sessionId && event.sessionId) sessionId = event.sessionId;
        // Result text is the final assembled text; prefer it if available
        if (event.text) {
          return { text: event.text, sessionId };
        }
        break;
    }
  }

  return { text: textParts.join(""), sessionId };
}
