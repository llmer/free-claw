import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { config } from "./config.js";
import { detectChromePath, isChromeRunning } from "./browser/chrome-manager.js";

const port = config.chromeDebugPort;

async function getVersionInfo(p: number): Promise<string> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${p}/json/version`, { timeout: 2_000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    });
    req.on("error", () => resolve(""));
    req.on("timeout", () => { req.destroy(); resolve(""); });
  });
}

async function main() {
  // Check if Chrome is already running on the port
  if (await isChromeRunning(port)) {
    const info = await getVersionInfo(port);
    let browser = "Chrome";
    try {
      const parsed = JSON.parse(info);
      browser = parsed.Browser || browser;
    } catch { /* ignore */ }
    console.log(`Chrome already running on port ${port} (${browser})`);
    console.log(`CDP endpoint: http://127.0.0.1:${port}`);
    console.log(`Profile: ${config.chromeUserDataDir}`);
    console.log(`\nOpen chrome://inspect or navigate manually in the browser.`);
    console.log(`Press Ctrl+C to disconnect (Chrome keeps running).`);
    // Keep process alive so user sees the output, exit on signal
    process.on("SIGINT", () => process.exit(0));
    process.on("SIGTERM", () => process.exit(0));
    return;
  }

  // Launch Chrome in non-headless mode for interactive use
  const chromePath = detectChromePath();
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${config.chromeUserDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];

  fs.mkdirSync(config.chromeUserDataDir, { recursive: true });

  console.log(`Launching Chrome (non-headless) for profile setup...`);
  console.log(`Binary: ${chromePath}`);
  console.log(`Profile: ${config.chromeUserDataDir}`);
  console.log(`CDP port: ${port}`);
  console.log(`\nLog into your sites, then close Chrome when done.`);
  console.log(`Cookies and sessions will persist in the profile directory.\n`);

  const proc = spawn(chromePath, args, {
    detached: false,
    stdio: "inherit",
  });

  proc.on("error", (err) => {
    console.error(`Failed to launch Chrome: ${err.message}`);
    process.exit(1);
  });

  proc.on("exit", (code) => {
    console.log(`\nChrome exited (code=${code}). Profile saved.`);
    process.exit(0);
  });

  // Forward signals to Chrome
  process.on("SIGINT", () => proc.kill("SIGTERM"));
  process.on("SIGTERM", () => proc.kill("SIGTERM"));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
