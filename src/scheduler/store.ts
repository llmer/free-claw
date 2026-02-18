import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { SchedulerStoreFile } from "./types.js";

const STORE_PATH = path.join(config.dataDir, "scheduler", "jobs.json");

/**
 * Load scheduler store from disk.
 */
export async function loadSchedulerStore(): Promise<SchedulerStoreFile> {
  try {
    const raw = await fs.promises.readFile(STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return {
        version: 1,
        jobs: Array.isArray(parsed.jobs) ? parsed.jobs.filter(Boolean) : [],
        timezones: parsed.timezones ?? {},
      };
    }
    return { version: 1, jobs: [], timezones: {} };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, jobs: [], timezones: {} };
    }
    throw err;
  }
}

/**
 * Save scheduler store to disk with atomic write (temp + rename + backup).
 */
export async function saveSchedulerStore(store: SchedulerStoreFile): Promise<void> {
  await fs.promises.mkdir(path.dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  const json = JSON.stringify(store, null, 2);
  await fs.promises.writeFile(tmp, json, "utf-8");
  await fs.promises.rename(tmp, STORE_PATH);
  try {
    await fs.promises.copyFile(STORE_PATH, `${STORE_PATH}.bak`);
  } catch {
    // best-effort
  }
}
