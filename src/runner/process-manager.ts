import type { ChildProcess } from "node:child_process";

/**
 * Tracks running Claude CLI child processes for cancellation and cleanup.
 */

const runningProcesses = new Map<number, { proc: ChildProcess; label: string }>();

export function trackProcess(chatId: number, proc: ChildProcess, label: string): void {
  runningProcesses.set(chatId, { proc, label });
}

export function untrackProcess(chatId: number): void {
  runningProcesses.delete(chatId);
}

export function getRunningProcess(chatId: number): ChildProcess | undefined {
  return runningProcesses.get(chatId)?.proc;
}

export function isRunning(chatId: number): boolean {
  return runningProcesses.has(chatId);
}

/**
 * Kill the running process for a chat. Returns true if a process was killed.
 */
export function cancelProcess(chatId: number): boolean {
  const entry = runningProcesses.get(chatId);
  if (!entry) return false;

  const { proc } = entry;
  try {
    if (!proc.killed) {
      proc.kill("SIGTERM");
    }
  } catch {
    // Process may have already exited
  }
  runningProcesses.delete(chatId);
  return true;
}

/**
 * Kill all running processes. Called on graceful shutdown.
 */
export function killAll(): void {
  for (const [chatId] of runningProcesses) {
    cancelProcess(chatId);
  }
}

/**
 * Get info about all running processes.
 */
export function listRunning(): Array<{ chatId: number; label: string; pid?: number }> {
  const result: Array<{ chatId: number; label: string; pid?: number }> = [];
  for (const [chatId, { proc, label }] of runningProcesses) {
    result.push({ chatId, label, pid: proc.pid });
  }
  return result;
}
