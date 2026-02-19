import { spawn } from "node:child_process";
import path from "node:path";
import { config } from "../config.js";
import { parseStreamLine, type StreamEvent } from "./stream-parser.js";
import { trackProcess, untrackProcess } from "./process-manager.js";

export type RunClaudeOptions = {
  prompt: string;
  sessionId: string;
  /** If true, this is a follow-up in an existing session (uses --resume). */
  isResume: boolean;
  workDir?: string;
  model?: string;
  mcpConfigPath?: string;
  timeoutMs?: number;
  noOutputTimeoutMs?: number;
  /** Telegram chat ID for process tracking (cancellation). */
  chatId?: number;
  /** Callback for streaming text chunks. */
  onText?: (text: string) => void;
  /** Callback for stream events. */
  onEvent?: (event: StreamEvent) => void;
  /** AbortSignal to cancel the run externally. */
  signal?: AbortSignal;
};

export type RunClaudeResult = {
  text: string;
  sessionId: string;
  exitCode: number | null;
  error?: string;
};

/**
 * Build CLI arguments for the claude command.
 */
function buildArgs(opts: RunClaudeOptions): string[] {
  const args: string[] = ["-p", "--verbose", "--output-format", "stream-json", "--dangerously-skip-permissions"];

  if (opts.isResume) {
    // Resume uses --resume instead of --session-id, --model, etc.
    args.push("--resume", opts.sessionId);
  } else {
    args.push("--session-id", opts.sessionId);
    args.push("--model", opts.model ?? config.claudeModel);
    if (opts.mcpConfigPath) {
      args.push("--mcp-config", opts.mcpConfigPath);
    }
  }

  args.push(opts.prompt);
  return args;
}

/**
 * Spawn Claude CLI as a child process with streaming output.
 */
export function runClaude(opts: RunClaudeOptions): Promise<RunClaudeResult> {
  return new Promise((resolve, reject) => {
    const args = buildArgs(opts);
    const workDir = opts.workDir ?? config.workspaceDir;
    const timeoutMs = opts.timeoutMs ?? config.timeoutMs;
    const noOutputTimeoutMs = opts.noOutputTimeoutMs ?? config.noOutputTimeoutMs;

    // Build clean env without CLAUDECODE variables
    const env = { ...process.env };
    delete env.CLAUDECODE;
    // Don't pass our own API keys to the child process
    delete env.ANTHROPIC_API_KEY;

    const proc = spawn("claude", args, {
      cwd: workDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // Enable process group killing
    });

    // Track for cancellation
    if (opts.chatId !== undefined) {
      trackProcess(opts.chatId, proc, opts.prompt.slice(0, 100));
    }

    let stdout = "";
    let stderr = "";
    let sessionId = opts.sessionId;
    let settled = false;
    let lastOutputAt = Date.now();

    // Overall timeout
    const overallTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          proc.kill("SIGTERM");
        } catch { /* ignore */ }
        resolve({
          text: accumulatedText || "(timed out after " + Math.round(timeoutMs / 1000) + "s)",
          sessionId,
          exitCode: null,
          error: "Process timed out",
        });
      }
    }, timeoutMs);

    // No-output watchdog
    let watchdogTimer = setInterval(() => {
      if (Date.now() - lastOutputAt > noOutputTimeoutMs) {
        if (!settled) {
          settled = true;
          try {
            proc.kill("SIGTERM");
          } catch { /* ignore */ }
          resolve({
            text: accumulatedText || "(no output for " + Math.round(noOutputTimeoutMs / 1000) + "s)",
            sessionId,
            exitCode: null,
            error: "No output timeout",
          });
        }
      }
    }, 10_000);

    // Abort signal support
    if (opts.signal) {
      const onAbort = () => {
        if (!settled) {
          settled = true;
          try {
            proc.kill("SIGTERM");
          } catch { /* ignore */ }
          resolve({
            text: accumulatedText || "(cancelled)",
            sessionId,
            exitCode: null,
            error: "Cancelled",
          });
        }
      };
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    let accumulatedText = "";
    let lineBuffer = "";

    proc.stdout!.on("data", (chunk: Buffer) => {
      lastOutputAt = Date.now();
      const data = chunk.toString("utf-8");
      stdout += data;
      lineBuffer += data;

      // Process complete lines
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop()!; // Keep incomplete line in buffer

      for (const line of lines) {
        const event = parseStreamLine(line);
        if (!event) {
          if (line.trim()) console.warn(`[runner] Unparsed line: ${line.slice(0, 300)}`);
          continue;
        }

        opts.onEvent?.(event);

        switch (event.type) {
          case "session":
            sessionId = event.sessionId;
            break;
          case "text":
            accumulatedText += event.text;
            opts.onText?.(accumulatedText);
            break;
          case "result":
            if (event.sessionId) sessionId = event.sessionId;
            if (event.text) accumulatedText = event.text;
            break;
          case "error":
            // Accumulate errors into text
            if (event.error) {
              accumulatedText += `\n[Error: ${event.error}]`;
            }
            break;
        }
      }
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      lastOutputAt = Date.now();
      stderr += chunk.toString("utf-8");
    });

    proc.on("error", (err) => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    proc.on("close", (code) => {
      // Process any remaining line in buffer
      if (lineBuffer.trim()) {
        const event = parseStreamLine(lineBuffer);
        if (event) {
          opts.onEvent?.(event);
          if (event.type === "text") {
            accumulatedText += event.text;
          } else if (event.type === "result") {
            if (event.sessionId) sessionId = event.sessionId;
            if (event.text) accumulatedText = event.text;
          }
        }
      }

      cleanup();
      if (!settled) {
        settled = true;
        const error = code !== 0 ? stderr.trim() || `Process exited with code ${code}` : undefined;
        if (error) {
          console.warn(`[runner] Claude process exited with code ${code}: ${error}`);
        }
        if (!accumulatedText.trim() && !stderr.trim()) {
          console.warn(`[runner] Claude process produced no output (exit code: ${code}, stdout bytes: ${stdout.length}, stderr bytes: ${stderr.length})`);
        }
        resolve({
          text: accumulatedText.trim() || stderr.trim() || "(no output)",
          sessionId,
          exitCode: code,
          error,
        });
      }
    });

    function cleanup() {
      clearTimeout(overallTimer);
      clearInterval(watchdogTimer);
      if (opts.chatId !== undefined) {
        untrackProcess(opts.chatId);
      }
    }
  });
}
