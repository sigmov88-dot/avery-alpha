import fs from "node:fs";
import path from "node:path";
import { configDir } from "../config/index.ts";

/**
 * MCP server config — формат совместим с Claude Code (.mcp.json):
 * { "mcpServers": { "fs": { "command": "npx", "args": [...], "env": {...} } } }
 * HTTP-сервер: { "url": "https://...", "headers": {...} }
 */
export interface McpServerConfig {
  /** stdio transport: команда для запуска сервера */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** HTTP transport (streamable HTTP) */
  url?: string;
  headers?: Record<string, string>;
}

export type McpScope = "user" | "project";

export interface MergedMcpServer {
  name: string;
  scope: McpScope;
  config: McpServerConfig;
}

/** User scope: ~/.config/avery/mcp.json */
export function userMcpPath(): string {
  return path.join(configDir(), "mcp.json");
}

/** Project scope: <cwd>/.mcp.json (как в Claude Code) */
export function projectMcpPath(cwd: string): string {
  return path.join(cwd, ".mcp.json");
}

function readServers(filePath: string): Record<string, McpServerConfig> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const servers = (parsed as { mcpServers?: unknown }).mcpServers;
      if (servers && typeof servers === "object" && !Array.isArray(servers)) {
        return servers as Record<string, McpServerConfig>;
      }
    }
  } catch {
    // file missing or invalid — treat as empty
  }
  return {};
}

function writeServers(
  filePath: string,
  servers: Record<string, McpServerConfig>,
  mode?: number,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = JSON.stringify({ mcpServers: servers }, null, 2) + "\n";
  fs.writeFileSync(filePath, body, mode === undefined ? "utf8" : { mode });
}

/** Merge user + project servers. Project wins on name conflicts. */
export function loadMcpServers(cwd: string): MergedMcpServer[] {
  const merged = new Map<string, MergedMcpServer>();
  for (const [name, config] of Object.entries(readServers(userMcpPath()))) {
    merged.set(name, { name, scope: "user", config });
  }
  for (const [name, config] of Object.entries(
    readServers(projectMcpPath(cwd)),
  )) {
    merged.set(name, { name, scope: "project", config });
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function saveMcpServer(
  scope: McpScope,
  cwd: string,
  name: string,
  config: McpServerConfig,
): void {
  const filePath = scope === "user" ? userMcpPath() : projectMcpPath(cwd);
  const servers = readServers(filePath);
  servers[name] = config;
  // user scope может содержать токены в env/headers — как config.json
  writeServers(filePath, servers, scope === "user" ? 0o600 : undefined);
}

export function removeMcpServer(
  scope: McpScope,
  cwd: string,
  name: string,
): boolean {
  const filePath = scope === "user" ? userMcpPath() : projectMcpPath(cwd);
  const servers = readServers(filePath);
  if (!(name in servers)) return false;
  delete servers[name];
  writeServers(filePath, servers, scope === "user" ? 0o600 : undefined);
  return true;
}
