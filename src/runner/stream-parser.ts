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

  // Assistant text chunks
  if (type === "assistant" && parsed.subtype === "text") {
    const text = typeof parsed.text === "string" ? parsed.text : "";
    if (text) return { type: "text", text };
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
