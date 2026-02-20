/**
 * Convert GitHub-flavored Markdown to Telegram-compatible HTML.
 * Regex-based, zero dependencies. Handles streaming (unclosed code blocks).
 */

type Placeholder = { key: string; html: string };

let _n = 0;
function ph(): string {
  return `\x00P${++_n}\x00`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function markdownToTelegramHtml(md: string): string {
  const phs: Placeholder[] = [];
  let t = md;

  // 1. Fenced code blocks (closed)
  t = t.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const k = ph();
    const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    phs.push({ key: k, html: `<pre><code${cls}>${escapeHtml(code.trimEnd())}</code></pre>` });
    return k;
  });

  // Unclosed fenced code block at end (streaming)
  t = t.replace(/```(\w*)\n?([\s\S]+)$/, (_, lang, code) => {
    const k = ph();
    const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    phs.push({ key: k, html: `<pre><code${cls}>${escapeHtml(code.trimEnd())}</code></pre>` });
    return k;
  });

  // 2. Inline code
  t = t.replace(/`([^`\n]+)`/g, (_, code) => {
    const k = ph();
    phs.push({ key: k, html: `<code>${escapeHtml(code)}</code>` });
    return k;
  });

  // 3. Escape HTML in remaining text
  t = escapeHtml(t);

  // 4. Markdown → HTML conversions
  t = t.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  t = t.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, "<i>$1</i>");
  t = t.replace(/~~(.+?)~~/g, "<s>$1</s>");
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  t = t.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  t = t.replace(/(?:^&gt;[ \t]?.*$\n?)+/gm, (match) => {
    const lines = match.trimEnd().split("\n").map(l => l.replace(/^&gt;[ \t]?/, ""));
    return `<blockquote>${lines.join("\n")}</blockquote>\n`;
  });

  // 5. Restore placeholders
  for (const { key, html } of phs) {
    t = t.replace(key, html);
  }

  return t;
}

/** Detect Telegram 400 parse errors (bad HTML formatting). */
export function isTelegramParseError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  return (
    e.error_code === 400 &&
    typeof e.description === "string" &&
    /can't parse entities/i.test(e.description)
  );
}
