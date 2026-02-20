import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config before importing the module under test.
vi.mock("../config.js", () => ({
  config: {
    permissionMode: "dontAsk",
    allowedTools: null,
    extraAllowedTools: [],
    sandboxAdditionalDirs: null,
    dataDir: "/data",
    uploadsDir: "/data/uploads",
    workspaceDir: "/workspace",
    claudeModel: "",
  },
}));

import { buildArgs, DEFAULT_ALLOWED_TOOLS } from "./claude-cli.js";
import { config } from "../config.js";

// Cast config to mutable for per-test overrides
const mutableConfig = config as Record<string, unknown>;

describe("DEFAULT_ALLOWED_TOOLS", () => {
  const dangerous = ["rm", "rmdir", "sudo", "su", "kill", "killall", "pkill", "dd", "mkfs", "shutdown", "reboot", "chown"];

  for (const cmd of dangerous) {
    it(`does not contain Bash(${cmd}:*)`, () => {
      expect(DEFAULT_ALLOWED_TOOLS).not.toContain(`Bash(${cmd}:*)`);
    });
  }

  it("contains expected safe tools", () => {
    expect(DEFAULT_ALLOWED_TOOLS).toContain("Read");
    expect(DEFAULT_ALLOWED_TOOLS).toContain("Edit");
    expect(DEFAULT_ALLOWED_TOOLS).toContain("Write");
    expect(DEFAULT_ALLOWED_TOOLS).toContain("Bash(git:*)");
    expect(DEFAULT_ALLOWED_TOOLS).toContain("mcp__playwright__*");
    expect(DEFAULT_ALLOWED_TOOLS).toContain("WebFetch");
  });
});

describe("buildArgs", () => {
  const baseOpts = {
    prompt: "hello",
    sessionId: "sess-1",
    isResume: false,
  };

  beforeEach(() => {
    mutableConfig.permissionMode = "dontAsk";
    mutableConfig.allowedTools = null;
    mutableConfig.extraAllowedTools = [];
    mutableConfig.sandboxAdditionalDirs = null;
    mutableConfig.dataDir = "/data";
    mutableConfig.uploadsDir = "/data/uploads";
    mutableConfig.workspaceDir = "/workspace";
    mutableConfig.claudeModel = "";
  });

  it("does NOT include --dangerously-skip-permissions", () => {
    const args = buildArgs(baseOpts);
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("includes --permission-mode on fresh session", () => {
    const args = buildArgs(baseOpts);
    const idx = args.indexOf("--permission-mode");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("dontAsk");
  });

  it("includes --permission-mode on resume", () => {
    const args = buildArgs({ ...baseOpts, isResume: true });
    const idx = args.indexOf("--permission-mode");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("dontAsk");
  });

  it("includes --allowedTools with defaults when no override", () => {
    const args = buildArgs(baseOpts);
    const idx = args.indexOf("--allowedTools");
    expect(idx).toBeGreaterThan(-1);
    // The tool entries follow --allowedTools as varargs
    expect(args[idx + 1]).toBe(DEFAULT_ALLOWED_TOOLS[0]);
  });

  it("uses ALLOWED_TOOLS override when set (replaces defaults)", () => {
    mutableConfig.allowedTools = ["Read", "Write"];
    const args = buildArgs(baseOpts);
    const idx = args.indexOf("--allowedTools");
    expect(idx).toBeGreaterThan(-1);
    // Only the override tools should follow, not defaults
    expect(args[idx + 1]).toBe("Read");
    expect(args[idx + 2]).toBe("Write");
    // Default tools should not be present
    expect(args).not.toContain("Bash(git:*)");
  });

  it("appends EXTRA_ALLOWED_TOOLS to defaults", () => {
    mutableConfig.extraAllowedTools = ["Bash(rm:*)", "Bash(kill:*)"];
    const args = buildArgs(baseOpts);
    expect(args).toContain("Bash(rm:*)");
    expect(args).toContain("Bash(kill:*)");
    // Defaults should still be present
    expect(args).toContain("Read");
    expect(args).toContain("Bash(git:*)");
  });

  it("includes --add-dir for dataDir and uploadsDir", () => {
    const args = buildArgs(baseOpts);
    const idx = args.indexOf("--add-dir");
    expect(idx).toBeGreaterThan(-1);
    expect(args).toContain("/data");
    expect(args).toContain("/data/uploads");
  });

  it("deduplicates --add-dir entries", () => {
    // When dataDir and uploadsDir are the same
    mutableConfig.uploadsDir = "/data";
    const args = buildArgs(baseOpts);
    const addDirIdx = args.indexOf("--add-dir");
    // Count how many times /data appears after --add-dir
    const dirsAfterFlag = args.slice(addDirIdx + 1);
    const dataDirCount = dirsAfterFlag.filter(a => a === "/data").length;
    expect(dataDirCount).toBe(1);
  });

  it("excludes workDir from --add-dir", () => {
    mutableConfig.dataDir = "/workspace";
    mutableConfig.uploadsDir = "/workspace";
    const args = buildArgs(baseOpts);
    // No --add-dir needed since both dirs equal workDir
    expect(args).not.toContain("--add-dir");
  });

  it("uses custom sandboxAdditionalDirs when set", () => {
    mutableConfig.sandboxAdditionalDirs = ["/custom/path"];
    const args = buildArgs(baseOpts);
    const idx = args.indexOf("--add-dir");
    expect(idx).toBeGreaterThan(-1);
    expect(args).toContain("/custom/path");
    // Default dataDir/uploadsDir should not appear
    expect(args).not.toContain("/data/uploads");
  });

  it("passes sandbox args on resume too", () => {
    const args = buildArgs({ ...baseOpts, isResume: true });
    expect(args).toContain("--permission-mode");
    expect(args).toContain("--allowedTools");
    expect(args).toContain("--add-dir");
  });

  it("prompt is always last argument", () => {
    const args = buildArgs(baseOpts);
    expect(args[args.length - 1]).toBe("hello");
  });
});
