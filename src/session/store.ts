import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { ChatSession, SessionStoreFile } from "./types.js";

const STORE_PATH = path.join(config.dataDir, "sessions.json");

/**
 * Load sessions from disk. Returns empty store if file doesn't exist.
 */
export async function loadSessions(): Promise<SessionStoreFile> {
  try {
    const raw = await fs.promises.readFile(STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.sessions) {
      return { version: 1, sessions: parsed.sessions };
    }
    return { version: 1, sessions: {} };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, sessions: {} };
    }
    throw err;
  }
}

/**
 * Save sessions to disk with atomic write (temp + rename + backup).
 */
export async function saveSessions(store: SessionStoreFile): Promise<void> {
  await fs.promises.mkdir(path.dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  const json = JSON.stringify(store, null, 2);
  await fs.promises.writeFile(tmp, json, "utf-8");
  await fs.promises.rename(tmp, STORE_PATH);
  try {
    await fs.promises.copyFile(STORE_PATH, `${STORE_PATH}.bak`);
  } catch {
    // best-effort backup
  }
}

/**
 * Get session for a chat, or undefined if none exists.
 */
export async function getSession(chatId: number): Promise<ChatSession | undefined> {
  const store = await loadSessions();
  return store.sessions[String(chatId)];
}

/**
 * Save/update a single session.
 */
export async function putSession(session: ChatSession): Promise<void> {
  const store = await loadSessions();
  store.sessions[String(session.chatId)] = session;
  await saveSessions(store);
}

/**
 * Remove a session.
 */
export async function deleteSession(chatId: number): Promise<void> {
  const store = await loadSessions();
  delete store.sessions[String(chatId)];
  await saveSessions(store);
}
