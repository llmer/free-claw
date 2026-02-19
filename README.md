# free-claw

Telegram bot that wraps the `claude` CLI. Send messages from your phone, get responses async. Supports session persistence, browser access via Playwright, and scheduled tasks.

## Prerequisites

- **Node.js 22+**
- **Claude CLI** installed and authenticated (`claude` must be on your PATH)
- **Telegram bot token** from [@BotFather](https://t.me/BotFather)
- Your **Telegram user ID** (send `/start` to [@userinfobot](https://t.me/userinfobot) to get it)

## Setup

```bash
git clone https://github.com/llmer/free-claw.git && cd free-claw
pnpm install
cp .env.example .env
```

Edit `.env`:

```
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...    # from BotFather
ALLOWED_TELEGRAM_USERS=12345678         # your Telegram user ID (comma-separated for multiple)
WORKSPACE_DIR=~/projects                # working directory for Claude Code
```

Run:

```bash
pnpm dev
```

That's it. Message your bot on Telegram.

## .env reference

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | *required* | Bot token from @BotFather |
| `ALLOWED_TELEGRAM_USERS` | (all) | Comma-separated Telegram user IDs. Leave empty to allow anyone (not recommended). |
| `WORKSPACE_DIR` | `~/projects` | Working directory for Claude Code sessions |
| `DATA_DIR` | `~/.free-claw` | Where session and scheduler data is persisted |
| `CLAUDE_MODEL` | `sonnet` | Default model passed to `claude --model` |
| `ENABLE_BROWSER` | `true` | Enable Playwright MCP for web browsing. Set `false` to disable. |
| `TIMEOUT_MS` | `600000` | Overall process timeout (10 min) |
| `NO_OUTPUT_TIMEOUT_MS` | `180000` | Kill process if no output for this long (3 min) |
| `DEFAULT_TIMEZONE` | system tz | IANA timezone for scheduling (e.g. `America/New_York`) |

## Commands

| Command | Description |
|---|---|
| `/start` | Show help |
| `/new` | Start a fresh conversation (new session ID) |
| `/cancel` | Kill the running Claude process |
| `/status` | Show current session info |
| `/schedule <time> \| <prompt>` | One-off scheduled task |
| `/every <pattern> \| <prompt>` | Recurring scheduled task |
| `/jobs` | List all scheduled jobs |
| `/canceljob <id>` | Cancel a job (prefix match on 8-char ID) |
| `/runjob <id>` | Force-run a job immediately |
| `/timezone <tz>` | Set your timezone for scheduling |

Any other text message is forwarded directly to Claude Code.

## Scheduling examples

One-off:
```
/schedule tomorrow at 10pm | remind me about the deadline
/schedule in 2 hours | check deployment status
/schedule Friday at 3pm | review the PR
```

Recurring:
```
/every morning at 9am | summarize my emails
/every weekday at 8:30am | check overnight alerts
/every 30 minutes | monitor the build pipeline
/every Monday at 10am | prepare weekly status report
```

## How it works

The bot spawns `claude` as a child process using documented CLI flags:

```
claude -p --output-format stream-json --dangerously-skip-permissions \
  --session-id <uuid> --model sonnet "your message"
```

Follow-ups use `--resume <session-id>` to maintain conversation context. No API keys are extracted or shared — everything goes through the CLI binary.

Responses stream back to Telegram via edit-in-place (the message updates live as Claude types), then the final complete response replaces the preview.

## Docker

```bash
docker compose up -d
```

The compose file mounts your data and workspace directories. Make sure the `claude` CLI is available inside the container (install it in the Dockerfile or mount the binary).

## Project structure

```
src/
  index.ts              # Entry point, wires everything together
  config.ts             # Loads .env, validates config
  telegram/
    bot.ts              # grammY bot, access control, message handler
    commands.ts         # All slash commands
    streaming.ts        # Throttled edit-in-place streaming to Telegram
  session/
    manager.ts          # Session lifecycle: new/resume/cancel
    store.ts            # JSON file persistence for sessions
    types.ts            # ChatSession, TaskRun interfaces
    queue.ts            # Per-chat serialized execution queue
  runner/
    claude-cli.ts       # Spawn claude CLI, build args, parse output
    stream-parser.ts    # Parse NDJSON from --output-format stream-json
    process-manager.ts  # Track PIDs, handle cancellation/cleanup
  scheduler/
    types.ts            # ScheduledJob, CronSchedule types
    schedule.ts         # computeNextRunAtMs() — cron/interval/one-shot
    parse-time.ts       # Natural language → schedule (chrono-node + regex)
    store.ts            # Atomic JSON persistence for jobs
    service.ts          # Timer loop, job lifecycle, backoff, CRUD
    executor.ts         # Bridge: scheduler → runner → telegram delivery
  security/
    sanitize.ts         # Unicode control char stripping
    detect-injection.ts # Suspicious pattern detection + logging
  browser/
    mcp-config.ts       # Generate MCP config for @playwright/mcp
```
