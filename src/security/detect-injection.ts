/**
 * Detect suspicious patterns that may indicate prompt injection.
 * These are logged for monitoring but content is still processed.
 * The user is authorized, so we don't block — just observe.
 */

const SUSPICIOUS_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?)/i,
  /disregard\s+(all\s+)?(previous|prior|above)/i,
  /forget\s+(everything|all|your)\s+(instructions?|rules?|guidelines?)/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /new\s+instructions?:/i,
  /system\s*:?\s*(prompt|override|command)/i,
  /\bexec\b.*command\s*=/i,
  /rm\s+-rf/i,
  /delete\s+all\s+(emails?|files?|data)/i,
  /<\/?system>/i,
];

export function detectSuspiciousPatterns(content: string): string[] {
  const matches: string[] = [];
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(content)) {
      matches.push(pattern.source);
    }
  }
  return matches;
}

/**
 * Log any detected suspicious patterns. Returns true if any were found.
 */
export function checkAndLogInjection(
  content: string,
  source: string,
  log: (msg: string) => void = console.warn,
): boolean {
  const matches = detectSuspiciousPatterns(content);
  if (matches.length > 0) {
    log(`[security] Suspicious patterns detected from ${source}: ${matches.join(", ")}`);
    return true;
  }
  return false;
}
