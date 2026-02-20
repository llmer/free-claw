# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev          # Run in development (tsx src/index.ts)
pnpm build        # Compile TypeScript to dist/
pnpm start        # Run compiled output (node dist/index.js)
pnpm typecheck    # Type-check without emitting (tsc --noEmit)
```

Requires a `.env` with at least `TELEGRAM_BOT_TOKEN`. Copy `.env.example` as a starting point.

## Architecture

Telegram bot wrapping the `claude` CLI binary as a child process. Three major subsystems:

1. **Telegram bot** (`src/telegram/`) — grammY-based, receives messages, streams responses back via edit-in-place
2. **Session manager** (`src/session/`) — maps chatId → sessionId, serializes requests per-chat, persists to JSON
3. **Scheduler** (`src/scheduler/`) — timer loop for one-off and recurring jobs, with backoff and missed-job recovery

All three funnel through the **runner** (`src/runner/`) which spawns `claude` as a child process.

### CLI invocation

New session:
```
claude -p --output-format stream-json --permission-mode dontAsk --allowedTools <tools...> --add-dir <dirs...> --session-id <uuid> --model <model> --mcp-config <path> "prompt"
```

Resume (follow-up in existing session):
```
claude -p --output-format stream-json --permission-mode dontAsk --allowedTools <tools...> --add-dir <dirs...> --append-system-prompt <prompt> --resume <session-id> "prompt"
```

**Critical:** On resume, `--model`, `--mcp-config`, and `--session-id` are NOT passed — the CLI ignores them. Only `--resume` + prompt. However, permission flags (`--permission-mode`, `--allowedTools`, `--add-dir`) and `--append-system-prompt` MUST be passed on every invocation including resume — they are not inherited across sessions. The decision for session-specific flags is based on `session.messageCount > 0`.

### Per-chat queue

`src/session/queue.ts` ensures only one Claude process runs per chat at a time. Messages arriving during a run are chained sequentially via Promise. Errors are swallowed to maintain queue continuity.

### Streaming

Claude outputs NDJSON (`stream-json`). The stream parser (`src/runner/stream-parser.ts`) extracts text chunks, result events, and session IDs line-by-line. A line buffer handles partial lines; the remaining buffer is checked after process close.

Telegram streaming (`src/telegram/streaming.ts`) throttles edit-in-place at 1.5s intervals with a 30-char initial debounce to avoid noisy push notifications. Messages over 4096 chars stop streaming and get re-sent as chunked messages.

### Process management

Processes are spawned with `detached: true` for process group killing. Cancellation uses `process.kill(-proc.pid, "SIGTERM")` (negative PID = kill group). Two independent timeout timers run per process:
- **Overall timeout** (10 min default) — absolute cap
- **No-output watchdog** (3 min default) — kills if stdout/stderr goes silent

Both resolve with partial text rather than rejecting.

### Scheduler timer loop

`src/scheduler/service.ts` polls with `setTimeout`, capped at 60s (`MAX_TIMER_DELAY_MS`). A `running` flag prevents concurrent job execution — if the timer fires while a job runs, it reschedules and returns. Jobs use exponential backoff on error (30s → 1m → 5m → 15m → 60m). One-shot `at` jobs are disabled after any terminal status and deleted on success. Stuck-run detection clears `runningAtMs` markers older than 2 hours on startup.

### Persistence

Both session store (`~/.free-claw/sessions.json`) and scheduler store (`~/.free-claw/scheduler/jobs.json`) use atomic writes: write to temp file → rename → best-effort backup copy.

### Wiring quirk in index.ts

The bot is created twice: first to get the API reference for the scheduler, then recreated with the scheduler attached for command handlers. This is because the scheduler needs `bot.api` for Telegram delivery, while command handlers need the scheduler instance.

## Module dependency flow

```
index.ts
├── config.ts (singleton, loads .env on import)
├── telegram/bot.ts → commands.ts, streaming.ts
│   └── session/manager.ts → queue.ts, store.ts
│       └── runner/claude-cli.ts → stream-parser.ts, process-manager.ts
├── scheduler/service.ts → schedule.ts, parse-time.ts, store.ts
│   └── scheduler/executor.ts → runner/claude-cli.ts, telegram/streaming.ts
├── security/sanitize.ts, detect-injection.ts
└── browser/mcp-config.ts
```

## Key conventions

- ESM throughout (`"type": "module"` in package.json, `.js` extensions in imports)
- `config` is a module-level singleton — imported at top level, never conditionally
- All path `~` expansion happens at config load time
- Logging uses `console.log`/`console.warn`/`console.error` with bracket prefixes: `[init]`, `[scheduler]`, `[shutdown]`, `[access]`, `[security]`
