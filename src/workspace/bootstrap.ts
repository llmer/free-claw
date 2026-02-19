/**
 * Workspace seeding and identity file loading.
 * Seeds template files on first run, loads identity files for system prompt injection.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { WORKSPACE_FILES, TEMPLATE_BOOTSTRAP, TEMPLATE_IDENTITY } from "./templates.js";

/**
 * Ensure the workspace directory has all template files.
 * Uses `wx` flag so existing files are never overwritten.
 * Seeds BOOTSTRAP.md only if onboarding hasn't completed (IDENTITY.md still matches template).
 */
export async function ensureWorkspace(workspaceDir: string): Promise<void> {
  // Ensure workspace and memory dirs exist
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });

  // Seed each template file (skip if exists)
  for (const [filename, content] of Object.entries(WORKSPACE_FILES)) {
    const filePath = path.join(workspaceDir, filename);
    try {
      await fs.writeFile(filePath, content, { flag: "wx" });
      console.log(`[workspace] Seeded ${filename}`);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }

  // Seed BOOTSTRAP.md only if onboarding not yet complete
  if (!await isOnboardingComplete(workspaceDir)) {
    const bootstrapPath = path.join(workspaceDir, "BOOTSTRAP.md");
    try {
      await fs.writeFile(bootstrapPath, TEMPLATE_BOOTSTRAP, { flag: "wx" });
      console.log(`[workspace] Seeded BOOTSTRAP.md`);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

/** Identity files to load into the system prompt (small, ~2KB total). */
const IDENTITY_FILES = ["SOUL.md", "IDENTITY.md", "USER.md"] as const;

export type IdentityContent = {
  soul: string;
  identity: string;
  user: string;
  bootstrap: string | null;
};

/**
 * Load identity files for system prompt injection.
 * Returns content of SOUL.md, IDENTITY.md, USER.md, and BOOTSTRAP.md (if present).
 */
export async function loadIdentityFiles(workspaceDir: string): Promise<IdentityContent> {
  const readFile = async (filename: string): Promise<string> => {
    try {
      return await fs.readFile(path.join(workspaceDir, filename), "utf-8");
    } catch {
      return "";
    }
  };

  const [soul, identity, user] = await Promise.all(
    IDENTITY_FILES.map(readFile),
  );

  // BOOTSTRAP.md is optional — only present before onboarding completes
  let bootstrap: string | null = null;
  try {
    bootstrap = await fs.readFile(path.join(workspaceDir, "BOOTSTRAP.md"), "utf-8");
  } catch {
    // File doesn't exist — onboarding complete
  }

  return { soul, identity, user, bootstrap };
}

/**
 * Check if onboarding is complete.
 * Onboarding is complete when IDENTITY.md has been modified from the template
 * (i.e., the agent has filled in their identity) OR BOOTSTRAP.md has been deleted.
 */
export async function isOnboardingComplete(workspaceDir: string): Promise<boolean> {
  // If BOOTSTRAP.md doesn't exist, onboarding is done
  try {
    await fs.access(path.join(workspaceDir, "BOOTSTRAP.md"));
  } catch {
    // Check if IDENTITY.md exists and differs from template
    try {
      const identity = await fs.readFile(path.join(workspaceDir, "IDENTITY.md"), "utf-8");
      return identity.trim() !== TEMPLATE_IDENTITY.trim();
    } catch {
      // No identity file yet — not complete
      return false;
    }
  }

  // BOOTSTRAP.md exists — check if IDENTITY.md has been personalized
  try {
    const identity = await fs.readFile(path.join(workspaceDir, "IDENTITY.md"), "utf-8");
    return identity.trim() !== TEMPLATE_IDENTITY.trim();
  } catch {
    return false;
  }
}
