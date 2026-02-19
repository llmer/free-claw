/**
 * Bridge between scheduler and runner + telegram delivery.
 * Executes scheduled jobs by spawning Claude Code and delivering results.
 */

import type { Bot } from "grammy";
import { config } from "../config.js";
import { runClaude } from "../runner/claude-cli.js";
import { chunkText } from "../telegram/streaming.js";
import { ensureWorkspace, loadIdentityFiles } from "../workspace/bootstrap.js";
import { buildSystemPrompt } from "../workspace/system-prompt.js";
import type { ScheduledJob } from "./types.js";

export type ExecutorDeps = {
  api: Bot["api"];
  mcpConfigPath?: string;
};

const JOB_TIMEOUT_MS = 600_000; // 10 minutes

/**
 * Execute a scheduled job: spawn Claude Code and deliver results to Telegram.
 */
export async function executeScheduledJob(
  job: ScheduledJob,
  deps: ExecutorDeps,
): Promise<{ status: "ok" | "error"; error?: string; text?: string }> {
  const sessionId = `scheduled-${job.id}`;

  // Notify user that the job is running
  try {
    await deps.api.sendMessage(
      job.chatId,
      `Running scheduled task: ${job.name}\nPrompt: ${job.prompt.slice(0, 100)}${job.prompt.length > 100 ? "..." : ""}`,
    );
  } catch (err) {
    console.warn(`[scheduler] Failed to send start notification for job ${job.id}:`, err);
  }

  try {
    // Ensure workspace exists and build identity-aware system prompt
    await ensureWorkspace(config.workspaceDir);
    const identity = await loadIdentityFiles(config.workspaceDir);
    const appendSystemPrompt = buildSystemPrompt(identity, config.workspaceDir);

    const result = await runClaude({
      prompt: job.prompt,
      sessionId,
      isResume: false,
      workDir: job.workDir,
      mcpConfigPath: deps.mcpConfigPath,
      timeoutMs: JOB_TIMEOUT_MS,
      appendSystemPrompt,
    });

    // Deliver result to Telegram
    const text = result.text.trim() || "(no output)";
    const chunks = chunkText(text);
    for (const chunk of chunks) {
      try {
        await deps.api.sendMessage(job.chatId, chunk);
      } catch (err) {
        console.warn(`[scheduler] Failed to deliver result chunk for job ${job.id}:`, err);
      }
    }

    if (result.error) {
      return { status: "error", error: result.error, text };
    }
    return { status: "ok", text };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    // Notify user of failure
    try {
      await deps.api.sendMessage(
        job.chatId,
        `Scheduled task "${job.name}" failed: ${errorMsg}`,
      );
    } catch {
      // best-effort
    }

    return { status: "error", error: errorMsg };
  }
}
