import { spawn } from "node:child_process";
import { config } from "../config.js";
import { parseStreamLine, type StreamEvent } from "./stream-parser.js";
import { trackProcess, untrackProcess } from "./process-manager.js";

export const DEFAULT_ALLOWED_TOOLS: string[] = [
  // File tools (scoped to cwd + --add-dir)
  "Read", "Edit", "Write", "Glob", "Grep", "MultiEdit",
  // Agent / planning
  "Task", "TodoRead", "TodoWrite",
  // Web
  "WebFetch", "WebSearch",
  // MCP (Playwright browser)
  "mcp__playwright__*",
  // Bash: version control
  "Bash(git:*)",
  // Bash: file reading / search
  "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(find:*)",
  "Bash(grep:*)", "Bash(rg:*)", "Bash(wc:*)", "Bash(sort:*)", "Bash(uniq:*)",
  "Bash(diff:*)",
  // Bash: file manipulation (no rm)
  "Bash(mkdir:*)", "Bash(touch:*)", "Bash(cp:*)", "Bash(mv:*)",
  // Bash: dev toolchains
  "Bash(node:*)", "Bash(npm:*)", "Bash(npx:*)", "Bash(pnpm:*)", "Bash(yarn:*)",
  "Bash(tsc:*)", "Bash(tsx:*)", "Bash(python:*)", "Bash(python3:*)",
  "Bash(pip:*)", "Bash(pip3:*)", "Bash(cargo:*)", "Bash(go:*)", "Bash(make:*)",
  // Bash: text processing
  "Bash(sed:*)", "Bash(awk:*)", "Bash(jq:*)", "Bash(xargs:*)",
  // Bash: network
  "Bash(curl:*)", "Bash(wget:*)",
  // Bash: archives
  "Bash(tar:*)", "Bash(zip:*)", "Bash(unzip:*)",
  // Bash: system info / misc
  "Bash(echo:*)", "Bash(printf:*)", "Bash(date:*)", "Bash(which:*)",
  "Bash(pwd:*)", "Bash(whoami:*)", "Bash(uname:*)", "Bash(env:*)",
  "Bash(test:*)", "Bash(true:*)", "Bash(false:*)", "Bash(chmod:*)",
  // Bash: build / test
  "Bash(vitest:*)", "Bash(biome:*)", "Bash(docker:*)", "Bash(docker-compose:*)",
];

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
  /** System prompt to append (new sessions only, ignored on resume). */
  appendSystemPrompt?: string;
};

export type RunClaudeResult = {
  text: string;
  sessionId: string;
  exitCode: number | null;
  error?: string;
};

/**
 * Build sandbox/permission CLI arguments.
 * These are passed on every invocation (including --resume) because
 * permission flags are not inherited across CLI sessions.
 */
function buildSandboxArgs(opts: RunClaudeOptions): string[] {
  const args: string[] = ["--permission-mode", config.permissionMode];

  // Allowlist: use full override if ALLOWED_TOOLS is set, otherwise defaults + extras
  const tools = config.allowedTools ?? [
    ...DEFAULT_ALLOWED_TOOLS,
    ...config.extraAllowedTools,
  ];
  if (tools.length > 0) {
    args.push("--allowedTools", ...tools);
  }

  // Additional directories (beyond cwd) for file tool scoping
  const additionalDirs = config.sandboxAdditionalDirs ?? [config.dataDir, config.uploadsDir];
  const workDir = opts.workDir ?? config.workspaceDir;
  const extraDirs = [...new Set(additionalDirs.filter(Boolean))].filter(d => d !== workDir);
  if (extraDirs.length > 0) {
    args.push("--add-dir", ...extraDirs);
  }

  return args;
}

/**
 * Build CLI arguments for the claude command.
 */
export function buildArgs(opts: RunClaudeOptions): string[] {
  const args: string[] = ["-p", "--verbose", "--output-format", "stream-json"];
  args.push(...buildSandboxArgs(opts));

  if (opts.isResume) {
    // Resume uses --resume instead of --session-id, --model, etc.
    args.push("--resume", opts.sessionId);
  } else {
    args.push("--session-id", opts.sessionId);
    const model = opts.model ?? config.claudeModel;
    if (model) {
      args.push("--model", model);
    }
    if (opts.mcpConfigPath) {
      args.push("--mcp-config", opts.mcpConfigPath);
    }
    if (opts.appendSystemPrompt) {
      args.push("--append-system-prompt", opts.appendSystemPrompt);
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

    console.log(`[runner] Spawning: claude ${args.map(a => a.length > 80 ? a.slice(0, 80) + "…" : a).join(" ")}`);
    console.log(`[runner] cwd: ${workDir}`);
    if (opts.mcpConfigPath) console.log(`[runner] MCP config: ${opts.mcpConfigPath}`);

    const proc = spawn("claude", args, {
      cwd: workDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    /** Kill the entire process group so child processes are also terminated. */
    const killProc = () => {
      try {
        if (proc.pid) process.kill(-proc.pid, "SIGTERM");
      } catch { /* process may have already exited */ }
    };

    // Close stdin immediately — some CLIs behave differently with /dev/null vs a closed pipe
    proc.stdin!.end();

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
          killProc();
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
            killProc();
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
            killProc();
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
            if (event.text) {
              accumulatedText += event.text;
              opts.onText?.(accumulatedText);
            }
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
          if (event.type === "text" && event.text) {
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
        // Always log exit details for diagnostics
        console.log(`[runner] Claude process exited (code: ${code}, stdout: ${stdout.length} bytes, stderr: ${stderr.length} bytes)`);
        if (stderr.trim()) {
          console.warn(`[runner] stderr: ${stderr.trim().slice(0, 500)}`);
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
