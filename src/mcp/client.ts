import { spawn, type ChildProcess } from "node:child_process";
import { VERSION } from "../config/index.ts";
import { parseSSE } from "../provider/sse.ts";
import type { McpServerConfig } from "./config.ts";

const PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_TIMEOUT_MS = 30_000;

export class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpError";
  }
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface McpCallResult {
  content: string;
  isError: boolean;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/**
 * Minimal MCP client (JSON-RPC 2.0). Transports:
 * - stdio: newline-delimited JSON-RPC over a spawned child process
 * - http: streamable HTTP (POST JSON or SSE responses, session id header)
 */
export class McpClient {
  private readonly config: McpServerConfig;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private child: ChildProcess | undefined;
  private stderrTail = "";
  private spawnError: McpError | undefined;
  private url: string | undefined;
  private httpHeaders: Record<string, string>;
  private sessionId: string | undefined;
  private closed = false;

  private constructor(config: McpServerConfig) {
    this.config = config;
    this.httpHeaders = { ...(config.headers ?? {}) };
  }

  static async connect(
    config: McpServerConfig,
    opts: { timeoutMs?: number } = {},
  ): Promise<McpClient> {
    const client = new McpClient(config);
    if (config.url) client.startHttp();
    else await client.startStdio();
    await client.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "avery", version: VERSION },
      },
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    client.notify("notifications/initialized", {});
    return client;
  }

  async listTools(): Promise<McpToolDef[]> {
    const out: McpToolDef[] = [];
    let cursor: string | undefined;
    do {
      const result = (await this.request(
        "tools/list",
        cursor ? { cursor } : {},
      )) as { tools?: McpToolDef[]; nextCursor?: string };
      if (Array.isArray(result?.tools)) out.push(...result.tools);
      cursor =
        typeof result?.nextCursor === "string" && result.nextCursor.length > 0
          ? result.nextCursor
          : undefined;
    } while (cursor);
    return out;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult> {
    const result = (await this.request("tools/call", {
      name,
      arguments: args,
    })) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const parts = Array.isArray(result?.content) ? result.content : [];
    const text = parts
      .map((p) =>
        p?.type === "text" ? String(p.text ?? "") : JSON.stringify(p),
      )
      .join("\n");
    return { content: text || "(no content)", isError: result?.isError === true };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new McpError("MCP client closed"));
    }
    this.pending.clear();
    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = undefined;
    }
    if (this.url && this.sessionId) {
      // Best-effort session termination per the MCP HTTP spec.
      await fetch(this.url, {
        method: "DELETE",
        headers: { "mcp-session-id": this.sessionId, ...this.httpHeaders },
      }).catch(() => {});
    }
  }

  // ---- stdio transport ----

  private startStdio(): Promise<void> {
    const command = this.config.command;
    if (!command) throw new McpError("MCP server: missing command or url");
    const child = spawn(command, this.config.args ?? [], {
      env: { ...process.env, ...(this.config.env ?? {}) },
      // stdin нужен для JSON-RPC-запросов → pipe, а не ignore
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    // Resolves when the process spawned; rejects on ENOENT etc.
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (err) => {
        this.spawnError = new McpError(
          `MCP server failed to start (${command}): ${err.message}`,
        );
        reject(this.spawnError);
      });
    });
    spawned.catch(() => {}); // handled by the caller / failAll
    let buffer = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.length > 0) {
          try {
            this.dispatch(JSON.parse(line) as JsonRpcMessage);
          } catch {
            // non-JSON output on stdout — ignore
          }
        }
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    child.on("error", (err) => {
      this.spawnError = new McpError(
        `MCP server failed to start (${command}): ${err.message}`,
      );
      this.failAll(this.spawnError);
    });
    child.on("close", (code) => {
      if (!this.closed) {
        const tail = this.stderrTail.trim();
        this.failAll(
          new McpError(
            `MCP server exited (code ${code})${tail ? `: ${tail.slice(0, 300)}` : ""}`,
          ),
        );
      }
    });
    return spawned;
  }

  // ---- HTTP transport (streamable HTTP) ----

  private startHttp(): void {
    this.url = this.config.url;
  }

  private async sendHttp(payload: JsonRpcMessage): Promise<void> {
    const res = await fetch(this.url as string, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        "mcp-protocol-version": PROTOCOL_VERSION,
        ...this.httpHeaders,
      },
      body: JSON.stringify(payload),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (res.status === 202) return; // notification accepted, no body
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new McpError(
        `MCP HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      );
    }
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("text/event-stream")) {
      if (!res.body) return;
      for await (const data of parseSSE(res.body)) {
        try {
          this.dispatch(JSON.parse(data) as JsonRpcMessage);
        } catch {
          // ignore non-JSON events
        }
      }
      return;
    }
    const text = await res.text();
    // Часть серверов отвечает на уведомления 200 с пустым телом — это не
    // ошибка, диспетчить нечего.
    if (text.trim().length === 0) return;
    let body: JsonRpcMessage | JsonRpcMessage[];
    try {
      body = JSON.parse(text) as JsonRpcMessage | JsonRpcMessage[];
    } catch {
      return; // не-JSON ответ — игнорируем
    }
    for (const msg of Array.isArray(body) ? body : [body]) {
      this.dispatch(msg);
    }
  }

  // ---- shared JSON-RPC plumbing ----

  private dispatch(msg: JsonRpcMessage): void {
    if (msg.id === undefined) return; // notification — ignore
    const id = typeof msg.id === "string" ? Number.parseInt(msg.id, 10) : msg.id;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (msg.error) {
      p.reject(new McpError(msg.error.message ?? "MCP error"));
    } else {
      p.resolve(msg.result);
    }
  }

  private failAll(err: McpError): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private request(
    method: string,
    params?: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new McpError("MCP client closed"));
    const id = this.nextId++;
    const payload: JsonRpcMessage = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`MCP request "${method}" timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send(payload).catch((err: Error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  private notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const payload: JsonRpcMessage = { jsonrpc: "2.0", method, params };
    this.send(payload).catch(() => {});
  }

  private send(payload: JsonRpcMessage): Promise<void> {
    if (this.url) return this.sendHttp(payload);
    if (this.spawnError) return Promise.reject(this.spawnError);
    const child = this.child;
    if (!child?.stdin) {
      return Promise.reject(new McpError("MCP stdio transport not running"));
    }
    return new Promise((resolve, reject) => {
      child.stdin?.write(JSON.stringify(payload) + "\n", (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }
}
