import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { getCdpEndpoint } from "./chrome-manager.js";

export type McpConfig = {
  mcpServers: Record<string, {
    command: string;
    args: string[];
  }>;
};

/**
 * Generate MCP config for Playwright browser access.
 * Writes the config to a temp file and returns its path.
 */
export async function generateMcpConfig(): Promise<string | undefined> {
  if (!config.enableBrowser) {
    return undefined;
  }

  const mcpConfig: McpConfig = {
    mcpServers: {
      playwright: {
        command: "npx",
        args: ["-y", "@playwright/mcp@latest", `--cdp-endpoint=${getCdpEndpoint()}`],
      },
    },
  };

  const configDir = path.join(config.dataDir, "config");
  await fs.promises.mkdir(configDir, { recursive: true });
  const configPath = path.join(configDir, "mcp-config.json");
  await fs.promises.writeFile(configPath, JSON.stringify(mcpConfig, null, 2), "utf-8");
  return configPath;
}
