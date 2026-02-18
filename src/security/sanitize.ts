/**
 * Sanitize untrusted strings before embedding them into an LLM prompt.
 *
 * Strips Unicode "control" (Cc) + "format" (Cf) characters (includes CR/LF/NUL,
 * bidi marks, zero-width chars) and explicit line/paragraph separators (U+2028/U+2029).
 */
export function sanitizeForPrompt(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "");
}
