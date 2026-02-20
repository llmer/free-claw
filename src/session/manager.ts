import crypto from "node:crypto";
import { config } from "../config.js";
import { runClaude, type RunClaudeResult } from "../runner/claude-cli.js";
import { cancelProcess, isRunning } from "../runner/process-manager.js";
import { ensureWorkspace, loadIdentityFiles, isOnboardingComplete } from "../workspace/bootstrap.js";
import { buildSystemPrompt } from "../workspace/system-prompt.js";
import { trimBrowserTabs } from "../browser/tab-manager.js";
import { getSession, putSession } from "./store.js";
import { enqueue } from "./queue.js";
import type { ChatSession } from "./types.js";

export type SendMessageOptions = {
  chatId: number;
  prompt: string;
  mcpConfigPath?: string;
  /** Callback for streaming text updates. */
  onText?: (text: string) => void;
  /** Callback for when the response is complete. */
  onComplete?: (result: RunClaudeResult) => void;
  /** Callback for errors. */
  onError?: (error: Error) => void;
};

/**
 * Get or create a session for a chat.
 */
async function ensureSession(chatId: number): Promise<ChatSession> {
  await ensureWorkspace(config.workspaceDir);

  const existing = await getSession(chatId);
  if (existing) return existing;

  const session: ChatSession = {
    chatId,
    sessionId: crypto.randomUUID(),
    status: "idle",
    workDir: config.workspaceDir,
    createdAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    messageCount: 0,
  };
  await putSession(session);
  return session;
}

/**
 * Send a message to Claude Code through the session manager.
 * Serialized per-chat — only one run at a time per chat.
 */
export function sendMessage(opts: SendMessageOptions): Promise<RunClaudeResult> {
  return enqueue(opts.chatId, async () => {
    const session = await ensureSession(opts.chatId);
    const isResume = session.messageCount > 0;

    // Mark as running (don't increment messageCount yet — only on success)
    session.status = "running";
    session.lastMessageAt = new Date().toISOString();
    await putSession(session);

    try {
      // Build system prompt — needed for new sessions and for resume→new fallback
      const identity = await loadIdentityFiles(config.workspaceDir);
      const appendSystemPrompt = buildSystemPrompt(identity, config.workspaceDir);

      const buildRunOpts = (overrides?: { sessionId?: string; isResume?: boolean; mcpConfigPath?: string | null }) => ({
        prompt: opts.prompt,
        sessionId: overrides?.sessionId ?? session.sessionId,
        isResume: overrides?.isResume ?? isResume,
        workDir: session.workDir,
        mcpConfigPath: overrides && "mcpConfigPath" in overrides ? (overrides.mcpConfigPath ?? undefined) : opts.mcpConfigPath,
        chatId: opts.chatId,
        onText: opts.onText,
        appendSystemPrompt,
      });

      if (opts.mcpConfigPath) {
        await trimBrowserTabs();
      }

      let result = await runClaude(buildRunOpts());

      // If 0-byte output with MCP config, retry without it — MCP server may have failed to start
      if (result.exitCode === 0 && isNoOutput(result.text) && opts.mcpConfigPath) {
        console.warn(`[session] 0-byte output with MCP config, retrying without MCP`);
        result = await runClaude(buildRunOpts({ mcpConfigPath: null }));
      }

      // If resume failed because the session doesn't exist, retry as new session
      if (isResume && result.exitCode !== 0 && result.text.includes("No conversation found")) {
        console.warn(`[session] Session ${session.sessionId} not found in CLI, resetting to new session`);
        session.sessionId = crypto.randomUUID();
        session.messageCount = 0;
        result = await runClaude(buildRunOpts({ sessionId: session.sessionId, isResume: false }));

        // Check MCP fallback again for the fresh session
        if (result.exitCode === 0 && isNoOutput(result.text) && opts.mcpConfigPath) {
          console.warn(`[session] 0-byte output with MCP config, retrying without MCP`);
          result = await runClaude(buildRunOpts({ sessionId: session.sessionId, isResume: false, mcpConfigPath: null }));
        }
      }

      // Only advance state on success
      session.status = "idle";
      session.lastMessageAt = new Date().toISOString();
      if (result.exitCode === 0 && !isNoOutput(result.text)) {
        session.messageCount += 1;
        // Adopt session ID only from successful runs
        if (result.sessionId && result.sessionId !== session.sessionId) {
          session.sessionId = result.sessionId;
        }
        // Track onboarding completion
        if (!session.onboardingComplete && await isOnboardingComplete(config.workspaceDir)) {
          session.onboardingComplete = true;
          console.log(`[session] Onboarding complete for chat ${opts.chatId}`);
        }
      }
      await putSession(session);

      opts.onComplete?.(result);
      return result;
    } catch (err) {
      session.status = "idle";
      await putSession(session);
      const error = err instanceof Error ? err : new Error(String(err));
      opts.onError?.(error);
      throw error;
    }
  });
}

/**
 * Start a new session for a chat, discarding the old one.
 */
export async function newSession(chatId: number): Promise<ChatSession> {
  // Cancel any running process first
  cancelProcess(chatId);
  await ensureWorkspace(config.workspaceDir);

  const session: ChatSession = {
    chatId,
    sessionId: crypto.randomUUID(),
    status: "idle",
    workDir: config.workspaceDir,
    createdAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    messageCount: 0,
  };
  await putSession(session);
  return session;
}

/**
 * Cancel the running process for a chat.
 */
export async function cancelChat(chatId: number): Promise<boolean> {
  const killed = cancelProcess(chatId);
  const session = await getSession(chatId);
  if (session && session.status === "running") {
    session.status = "cancelled";
    await putSession(session);
  }
  return killed;
}

/**
 * Get the status of a chat session.
 */
export async function getStatus(chatId: number): Promise<{
  hasSession: boolean;
  session?: ChatSession;
  isRunning: boolean;
}> {
  const session = await getSession(chatId);
  return {
    hasSession: !!session,
    session: session ?? undefined,
    isRunning: isRunning(chatId),
  };
}

/** Check if the result text indicates no meaningful output was produced. */
function isNoOutput(text: string): boolean {
  const trimmed = text.trim();
  return !trimmed || trimmed === "(no output)";
}
