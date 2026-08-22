import type { Tool } from "../tools/index.ts";
import { McpClient, type McpToolDef } from "./client.ts";
import { loadMcpServers } from "./config.ts";

export interface McpServerStatus {
  name: string;
  scope: "user" | "project";
  ok: boolean;
  tools: number;
  error?: string;
}

export interface McpState {
  tools: Tool[];
  statuses: McpServerStatus[];
  close(): Promise<void>;
}

/** OpenAI/Anthropic tool names: ^[a-zA-Z0-9_-]{1,64}$ */
function sanitizeToolName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned.length > 64 ? cleaned.slice(0, 64) : cleaned;
}

function sanitizeSchema(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (input && typeof input === "object" && input.type === "object") return input;
  return { type: "object", properties: {} };
}

/** Wrap one MCP tool as an Avery tool named mcp__<server>__<tool>. */
function toAveryTool(
  serverName: string,
  client: McpClient,
  def: McpToolDef,
): Tool {
  return {
    // readOnlyHint → без подтверждения; destructiveHint → kind execute
    // (всегда спрашивает, даже если есть write-allowlist на write:).
    kind:
      def.annotations?.readOnlyHint === true
        ? "read"
        : def.annotations?.destructiveHint === true
          ? "execute"
          : "write",
    spec: {
      name: sanitizeToolName(`mcp__${serverName}__${def.name}`),
      description: `[MCP ${serverName}] ${def.description ?? def.name}`.slice(
        0,
        1024,
      ),
      parameters: sanitizeSchema(def.inputSchema) as Tool["spec"]["parameters"],
    },
    async execute(args) {
      const result = await client.callTool(def.name, args);
      if (result.isError) throw new Error(result.content);
      return result.content;
    },
  };
}

/**
 * Connect to every configured MCP server (user + project scopes) and adapt
 * their tools. Servers that fail to start are reported in statuses and
 * skipped — they never block the agent.
 */
export async function connectMcp(
  cwd: string,
  opts: { timeoutMs?: number } = {},
): Promise<McpState> {
  const servers = loadMcpServers(cwd);
  const tools: Tool[] = [];
  const statuses: McpServerStatus[] = [];
  const clients: McpClient[] = [];

  await Promise.all(
    servers.map(async (s) => {
      try {
        const client = await McpClient.connect(s.config, {
          timeoutMs: opts.timeoutMs,
        });
        const defs = await client.listTools();
        clients.push(client);
        for (const def of defs) {
          if (!def.name) continue;
          tools.push(toAveryTool(s.name, client, def));
        }
        statuses.push({ name: s.name, scope: s.scope, ok: true, tools: defs.length });
      } catch (e) {
        statuses.push({
          name: s.name,
          scope: s.scope,
          ok: false,
          tools: 0,
          error: (e as Error).message,
        });
      }
    }),
  );

  return {
    tools,
    statuses,
    async close() {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
    },
  };
}
