/**
 * Build the --append-system-prompt string from identity files + memory instructions.
 */

import { config } from "../config.js";
import type { IdentityContent } from "./bootstrap.js";

/**
 * Build the system prompt to append for new sessions.
 * Includes identity (from files) and instructions for memory access.
 */
export function buildSystemPrompt(identity: IdentityContent, workspaceDir: string): string {
  const sections: string[] = [];

  if (identity.soul) {
    sections.push(`# Your Identity\n${identity.soul.trim()}`);
  }

  if (identity.identity) {
    sections.push(`# Your Profile\n${identity.identity.trim()}`);
  }

  if (identity.user) {
    sections.push(`# Your Human\n${identity.user.trim()}`);
  }

  if (identity.bootstrap) {
    sections.push(`# First Run\n${identity.bootstrap.trim()}`);
  }

  sections.push(`# Memory & Continuity
You have persistent memory stored as files in your workspace (${workspaceDir}):
- \`MEMORY.md\` — your curated long-term memory. Read this at the start of every session.
- \`memory/\` directory — daily log files (YYYY-MM-DD.md). Read today's and yesterday's at session start.
- When you learn something worth remembering, write it to \`memory/YYYY-MM-DD.md\`.
- Periodically review daily files and promote important insights to \`MEMORY.md\`.
- When you need to recall something specific, use Grep to search through memory/ files.
- Daily logs may contain \`### Feedback\` sections with emoji reactions from your human. These show what landed well (👍 ❤ 🔥) and what didn't (👎). Pay attention to patterns — they're how you learn your human's taste and calibrate your style over time.
- You can update SOUL.md, IDENTITY.md, USER.md as you learn. Always tell your human when you change SOUL.md.`);

  sections.push(`# Communication
You're talking to your human via Telegram. Keep responses concise — Telegram has a 4096 char limit.`);

  sections.push(`# Scheduling Tasks
You have a built-in scheduler for recurring and one-off tasks. NEVER use launchd, cron, systemd, at, or external scripts for scheduling.

To schedule a task, write a JSON file to: \`${workspaceDir}/.scheduler-inbox.json\`

Format:
\`\`\`json
[{
  "action": "create",
  "name": "Short descriptive name",
  "prompt": "Full instructions for a fresh Claude session each run. Be detailed — each execution has no memory of previous runs (but can read/write workspace files for state).",
  "schedule": "every 2 hours",
  "expiresAt": "2026-03-01"
}]
\`\`\`

- \`schedule\`: "every 2 hours", "every morning at 9am", "every weekday at 8:30am", "tomorrow at 3pm", etc.
- \`expiresAt\`: (optional) ISO date or natural language date when recurring tasks auto-disable. Always set this for time-bound events (Olympics, conferences, deadlines, launches).
- \`prompt\`: Full instructions for a fresh Claude session. Be specific — each execution starts with no context. Include what to check, where to write results, and any formatting preferences. The session has full workspace + browser/MCP access.
- \`name\`: Short label shown in job listings.

The inbox file is processed automatically after your response. You'll see a confirmation message once the job is created.`);

  if (config.enableBrowser) {
    sections.push(`# Browser
When using browser tools, check open tabs first with browser_tabs(action="list"). If the site you need is already open in an existing tab, select it with browser_tabs(action="select") instead of navigating to a new page. Close tabs you no longer need with browser_tabs(action="close").`);
  }

  return sections.join("\n\n");
}
