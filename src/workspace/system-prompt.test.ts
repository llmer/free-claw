import { describe, it, expect, vi } from "vitest";

// Mock config before importing the module under test.
// config.ts has side effects (loads .env, requires TELEGRAM_BOT_TOKEN),
// so we mock the entire module.
vi.mock("../config.js", () => ({
  config: {
    enableBrowser: false,
  },
}));

import { buildSystemPrompt } from "./system-prompt.js";
import type { IdentityContent } from "./bootstrap.js";

describe("buildSystemPrompt", () => {
  const fullIdentity: IdentityContent = {
    soul: "I am a helpful bot",
    identity: "Bot v1.0",
    user: "Jim, a developer",
    bootstrap: "First run instructions",
  };

  it("includes all sections when all fields populated", () => {
    const result = buildSystemPrompt(fullIdentity, "/workspace");
    expect(result).toContain("# Your Identity");
    expect(result).toContain("I am a helpful bot");
    expect(result).toContain("# Your Profile");
    expect(result).toContain("Bot v1.0");
    expect(result).toContain("# Your Human");
    expect(result).toContain("Jim, a developer");
    expect(result).toContain("# First Run");
    expect(result).toContain("First run instructions");
    expect(result).toContain("# Memory & Continuity");
    expect(result).toContain("# Communication");
  });

  it("omits sections for empty fields", () => {
    const minimal: IdentityContent = { soul: "", identity: "", user: "", bootstrap: null };
    const result = buildSystemPrompt(minimal, "/workspace");
    expect(result).not.toContain("# Your Identity");
    expect(result).not.toContain("# Your Profile");
    expect(result).not.toContain("# Your Human");
    expect(result).not.toContain("# First Run");
    expect(result).toContain("# Memory & Continuity");
  });

  it("omits First Run when bootstrap is null", () => {
    const noBootstrap: IdentityContent = {
      soul: "soul",
      identity: "id",
      user: "user",
      bootstrap: null,
    };
    const result = buildSystemPrompt(noBootstrap, "/workspace");
    expect(result).not.toContain("# First Run");
  });

  it("interpolates workspaceDir into memory section", () => {
    const result = buildSystemPrompt(fullIdentity, "/my/workspace/path");
    expect(result).toContain("/my/workspace/path");
  });

  it("does not include browser section when enableBrowser is false", () => {
    const result = buildSystemPrompt(fullIdentity, "/workspace");
    expect(result).not.toContain("# Browser");
  });
});
