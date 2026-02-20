import { spawn, execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { config } from "../config.js";

const POLL_INTERVAL_MS = 500;
const LAUNCH_TIMEOUT_MS = 15_000;
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const STOP_GRACE_MS = 5_000;

let chromeProc: ChildProcess | null = null;
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
let restarting = false;

/**
 * Returns the CDP endpoint URL for the configured debug port.
 */
export function getCdpEndpoint(): string {
  return `http://127.0.0.1:${config.chromeDebugPort}`;
}

/**
 * Detect a usable Chrome binary path.
 */
export function detectChromePath(): string {
  if (config.chromePath) {
    return config.chromePath;
  }

  // macOS default locations
  const macPaths = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const p of macPaths) {
    if (fs.existsSync(p)) return p;
  }

  // Linux — try PATH
  try {
    const which = execSync("which google-chrome 2>/dev/null || which chromium-browser 2>/dev/null || which chromium 2>/dev/null", {
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();
    if (which) return which;
  } catch {
    // not found
  }

  throw new Error(
    "Could not find Chrome/Chromium. Set CHROME_PATH in your .env or install Google Chrome.",
  );
}

/**
 * Check if Chrome is already listening on the debug port.
 */
export function isChromeRunning(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, { timeout: 2_000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        resolve(data.includes("webSocketDebuggerUrl"));
      });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Wait for Chrome to become ready on the debug port.
 */
async function waitForChrome(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isChromeRunning(port)) return;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Chrome did not become ready on port ${port} within ${timeoutMs}ms`);
}

/**
 * Launch Chrome with remote debugging enabled.
 */
function launchChrome(chromePath: string): ChildProcess {
  const args = [
    `--remote-debugging-port=${config.chromeDebugPort}`,
    `--user-data-dir=${config.chromeUserDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ];

  if (config.chromeHeadless) {
    args.push("--headless=new");
  }

  fs.mkdirSync(config.chromeUserDataDir, { recursive: true });

  const proc = spawn(chromePath, args, {
    detached: false,
    stdio: "ignore",
  });

  proc.on("error", (err) => {
    console.error("[chrome] Process error:", err.message);
  });

  proc.on("exit", (code, signal) => {
    console.warn(`[chrome] Process exited (code=${code}, signal=${signal})`);
    if (chromeProc === proc) {
      chromeProc = null;
    }
  });

  return proc;
}

/**
 * Ensure Chrome is running on the configured debug port.
 * Reuses an existing instance if one is already listening.
 */
export async function ensureChromeRunning(): Promise<void> {
  if (!config.enableBrowser) return;

  const port = config.chromeDebugPort;

  // Check if something is already listening
  if (await isChromeRunning(port)) {
    console.log(`[chrome] Reusing existing Chrome on port ${port}`);
    return;
  }

  const chromePath = detectChromePath();
  console.log(`[chrome] Launching: ${chromePath}`);
  console.log(`[chrome] Profile: ${config.chromeUserDataDir}`);
  console.log(`[chrome] Headless: ${config.chromeHeadless}`);

  chromeProc = launchChrome(chromePath);

  await waitForChrome(port, LAUNCH_TIMEOUT_MS);
  console.log(`[chrome] Ready on port ${port}`);
}

/**
 * Stop the managed Chrome process.
 */
export async function stopChrome(): Promise<void> {
  if (!chromeProc) return;

  const proc = chromeProc;
  chromeProc = null;

  if (proc.exitCode !== null) return; // already exited

  console.log("[chrome] Stopping...");
  proc.kill("SIGTERM");

  // Wait for graceful exit, then force kill
  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, STOP_GRACE_MS);

    proc.on("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  if (!exited) {
    console.warn("[chrome] Force killing after grace period");
    proc.kill("SIGKILL");
  }

  console.log("[chrome] Stopped");
}

/**
 * Start periodic health checks that restart Chrome if our managed process crashes.
 */
export function startHealthCheck(): void {
  if (!config.enableBrowser) return;

  healthCheckTimer = setInterval(async () => {
    if (restarting) return;

    // Only restart if we launched Chrome ourselves and it died
    if (chromeProc !== null) return; // still running or never started by us

    const running = await isChromeRunning(config.chromeDebugPort);
    if (running) return; // someone else is running it, or it recovered

    restarting = true;
    console.warn("[chrome] Health check: Chrome not responding, restarting...");
    try {
      await ensureChromeRunning();
    } catch (err) {
      console.error("[chrome] Health check restart failed:", err instanceof Error ? err.message : err);
    } finally {
      restarting = false;
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

/**
 * Stop the health check interval.
 */
export function stopHealthCheck(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}
