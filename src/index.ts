import { execSync } from "node:child_process";
import { config } from "./config.js";
import { DEFAULT_ALLOWED_TOOLS } from "./runner/claude-cli.js";
import { createBot } from "./telegram/bot.js";
import { generateMcpConfig } from "./browser/mcp-config.js";
import { ensureChromeRunning, startHealthCheck, stopHealthCheck, stopChrome } from "./browser/chrome-manager.js";
import { SchedulerService } from "./scheduler/service.js";
import { killAll as killAllProcesses } from "./runner/process-manager.js";

async function main() {
  console.log("[init] Starting free-claw...");
  console.log(`[init] Workspace: ${config.workspaceDir}`);
  console.log(`[init] Data dir: ${config.dataDir}`);
  console.log(`[init] Model: ${config.claudeModel || "(CLI default)"}`);
  console.log(`[init] Browser: ${config.enableBrowser}`);
  console.log(`[init] Allowed users: ${config.allowedUsers.length > 0 ? config.allowedUsers.join(", ") : "(all)"}`);
  console.log(`[init] Permission mode: ${config.permissionMode}`);
  const effectiveTools = config.allowedTools ?? [...DEFAULT_ALLOWED_TOOLS, ...config.extraAllowedTools];
  console.log(`[init] Sandbox: ${effectiveTools.length} allowed tools${config.extraAllowedTools.length > 0 ? `, ${config.extraAllowedTools.length} extras` : ""}`);

  // Verify Claude CLI is accessible
  try {
    const version = execSync("claude --version", { timeout: 10_000, encoding: "utf-8" }).trim();
    console.log(`[init] Claude CLI: ${version}`);
  } catch (err) {
    console.error("[init] Failed to run 'claude --version' — is the CLI installed and on PATH?");
    console.error("[init]", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // Launch persistent Chrome for browser access
  if (config.enableBrowser) {
    try {
      await ensureChromeRunning();
      startHealthCheck();
    } catch (err) {
      console.warn("[init] Chrome failed to start — continuing without browser");
      console.warn("[init]", err instanceof Error ? err.message : err);
    }
  }

  // Generate MCP config for browser access
  const mcpConfigPath = await generateMcpConfig();
  if (mcpConfigPath) {
    console.log(`[init] MCP config: ${mcpConfigPath}`);
  }

  // Create bot first (needed for scheduler's API access)
  const bot = createBot({ mcpConfigPath });

  // Create and start scheduler
  const scheduler = new SchedulerService({
    api: bot.api,
    mcpConfigPath,
  });

  // Re-create bot with scheduler attached for command handlers
  const fullBot = createBot({ mcpConfigPath, scheduler });

  // Start scheduler
  await scheduler.start();

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[shutdown] Received ${signal}, shutting down...`);

    // Stop the scheduler timer loop
    scheduler.stop();

    // Kill all running Claude CLI processes
    killAllProcesses();

    // Stop the bot
    await fullBot.stop();

    // Stop Chrome last (MCP servers may still be connected)
    stopHealthCheck();
    await stopChrome();

    console.log("[shutdown] Done.");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Start polling
  console.log("[init] Bot starting...");
  await fullBot.start({
    allowed_updates: ["message", "callback_query", "message_reaction"],
    onStart: (botInfo) => {
      console.log(`[init] Bot @${botInfo.username} is running!`);
    },
  });
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
