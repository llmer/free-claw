/**
 * CDP-based tab list/trim via Chrome's HTTP JSON API.
 * Used to prevent runaway tab accumulation across sessions.
 */

import http from "node:http";
import { config } from "../config.js";

type CdpTab = {
  id: string;
  url: string;
  title: string;
  type: string;
};

/**
 * GET a Chrome CDP JSON endpoint and parse the response.
 */
function cdpGet<T>(port: number, path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, { timeout: 3_000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Failed to parse CDP response from ${path}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`CDP request to ${path} timed out`));
    });
  });
}

/**
 * Fire-and-forget GET to a CDP endpoint (used for /json/close).
 */
function cdpClose(port: number, tabId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/json/close/${tabId}`, { timeout: 3_000 }, () => {
      resolve();
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`CDP close request timed out for tab ${tabId}`));
    });
  });
}

/**
 * List open browser tabs, filtering to real pages only.
 */
export async function listTabs(port: number): Promise<CdpTab[]> {
  const all = await cdpGet<CdpTab[]>(port, "/json/list");
  return all.filter(
    (t) =>
      t.type === "page" &&
      !t.url.startsWith("devtools://") &&
      !t.url.startsWith("chrome-extension://"),
  );
}

/**
 * Close excess tabs if count exceeds maxTabs.
 * CDP returns tabs in activity order (most recent first), so we keep the front of the list.
 * Never closes about:blank or chrome:// pages, and never goes below 1 tab.
 */
export async function trimTabs(port: number, maxTabs: number): Promise<number> {
  if (maxTabs <= 0) return 0;

  const tabs = await listTabs(port);
  if (tabs.length <= maxTabs) return 0;

  // Tabs to consider closing: everything beyond maxTabs (least recently used)
  const excess = tabs.slice(maxTabs);
  const closable = excess.filter(
    (t) => !t.url.startsWith("about:") && !t.url.startsWith("chrome://"),
  );

  // Never close all tabs — ensure at least 1 remains
  const keepCount = tabs.length - closable.length;
  const safeToClose = keepCount >= 1 ? closable : closable.slice(0, closable.length - 1);

  let closed = 0;
  for (const tab of safeToClose) {
    try {
      await cdpClose(port, tab.id);
      closed++;
    } catch {
      // best-effort — don't block on individual tab close failures
    }
  }

  if (closed > 0) {
    console.log(`[tabs] Closed ${closed} excess tabs (had ${tabs.length}, max ${maxTabs})`);
  }

  return closed;
}

/**
 * Convenience wrapper: trim tabs using config values.
 * Silently no-ops if browser is disabled or Chrome isn't reachable.
 * Never throws — tab cleanup failing should not block Claude runs.
 */
export async function trimBrowserTabs(): Promise<void> {
  if (!config.enableBrowser || config.maxBrowserTabs <= 0) return;

  try {
    await trimTabs(config.chromeDebugPort, config.maxBrowserTabs);
  } catch {
    // Chrome not running or unreachable — silently skip
  }
}
