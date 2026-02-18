import crypto from "node:crypto";
import { config } from "../config.js";
import { runClaude, type RunClaudeResult } from "../runner/claude-cli.js";
import { cancelProcess, isRunning } from "../runner/process-manager.js";
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

    // Mark as running
    session.status = "running";
    session.lastMessageAt = new Date().toISOString();
    session.messageCount += 1;
    await putSession(session);

    try {
      const result = await runClaude({
        prompt: opts.prompt,
        sessionId: session.sessionId,
        isResume,
        workDir: session.workDir,
        mcpConfigPath: opts.mcpConfigPath,
        chatId: opts.chatId,
        onText: opts.onText,
      });

      // Update session with result
      session.status = "idle";
      session.lastMessageAt = new Date().toISOString();
      // If Claude returned a different session ID, update it
      if (result.sessionId && result.sessionId !== session.sessionId) {
        session.sessionId = result.sessionId;
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
