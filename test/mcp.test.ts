import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { McpClient } from "../src/mcp/client.ts";
import {
  loadMcpServers,
  projectMcpPath,
  removeMcpServer,
  saveMcpServer,
  userMcpPath,
} from "../src/mcp/config.ts";
import { connectMcp } from "../src/mcp/index.ts";

const FIXTURE = fileURLToPath(
  new URL("./fixtures/mock-mcp-server.mjs", import.meta.url),
);

const STDIO_CFG = { command: process.execPath, args: [FIXTURE] };

test("stdio: connect, listTools, callTool, errors", async () => {
  const client = await McpClient.connect(STDIO_CFG, { timeoutMs: 10_000 });
  const tools = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ["echo", "explode"],
  );
  assert.equal(tools[0]?.annotations?.readOnlyHint, true);

  const ok = await client.callTool("echo", { text: "hi" });
  assert.equal(ok.content, "echo:hi");
  assert.equal(ok.isError, false);

  const bad = await client.callTool("explode", {});
  assert.equal(bad.isError, true);
  assert.equal(bad.content, "boom");

  await client.close();
});

test("connectMcp adapts tools as mcp__<server>__<tool> with kinds", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "avery-mcp-"));
  fs.writeFileSync(
    path.join(dir, ".mcp.json"),
    JSON.stringify({ mcpServers: { mock: STDIO_CFG } }),
  );
  const state = await connectMcp(dir, { timeoutMs: 10_000 });
  try {
    assert.equal(state.statuses.length, 1);
    assert.equal(state.statuses[0]?.ok, true);
    assert.equal(state.statuses[0]?.tools, 2);

    const names = state.tools.map((t) => t.spec.name).sort();
    assert.deepEqual(names, ["mcp__mock__echo", "mcp__mock__explode"]);

    const echo = state.tools.find((t) => t.spec.name === "mcp__mock__echo");
    const explode = state.tools.find((t) => t.spec.name === "mcp__mock__explode");
    assert.equal(echo?.kind, "read"); // readOnlyHint → read, no permission
    assert.equal(explode?.kind, "write");

    const out = await echo?.execute({ text: "yo" }, { cwd: dir });
    assert.equal(out, "echo:yo");
    await assert.rejects(() => explode?.execute({}, { cwd: dir }), /boom/);
  } finally {
    await state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("failing server is reported, not fatal", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "avery-mcp-bad-"));
  fs.writeFileSync(
    path.join(dir, ".mcp.json"),
    JSON.stringify({
      mcpServers: { nope: { command: "definitely-not-a-real-binary-xyz" } },
    }),
  );
  const state = await connectMcp(dir, { timeoutMs: 5_000 });
  try {
    assert.equal(state.tools.length, 0);
    assert.equal(state.statuses[0]?.ok, false);
    assert.match(state.statuses[0]?.error ?? "", /failed to start|exited/i);
  } finally {
    await state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function withHttpServer(
  handler: http.RequestListener,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 500);
      server.close(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

test("http transport: session id, JSON and SSE responses", async () => {
  const seenSessionHeaders: Array<string | undefined> = [];
  await withHttpServer(
    (req, res) => {
      if (req.method === "DELETE") {
        // завершение сессии при close()
        res.statusCode = 200;
        res.end();
        return;
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seenSessionHeaders.push(req.headers["mcp-session-id"] as string | undefined);
        const msg = JSON.parse(body) as { id?: number; method?: string };
        if (msg.method === "initialize") {
          res.setHeader("content-type", "application/json");
          res.setHeader("mcp-session-id", "sess-1");
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { protocolVersion: "2024-11-05", capabilities: {} },
            }),
          );
          return;
        }
        if (msg.method === "tools/list") {
          // ответ в SSE-формате
          res.setHeader("content-type", "text/event-stream");
          res.end(
            "data: " +
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  tools: [{ name: "ping", inputSchema: { type: "object" } }],
                },
              }) +
              "\n\n",
          );
          return;
        }
        // notifications/initialized и прочее → 202
        res.statusCode = 202;
        res.end();
      });
    },
    async (base) => {
      const client = await McpClient.connect({ url: `${base}/mcp` });
      const tools = await client.listTools();
      assert.deepEqual(
        tools.map((t) => t.name),
        ["ping"],
      );
      // session id из initialize подставляется в следующие запросы
      assert.equal(seenSessionHeaders[0], undefined);
      assert.ok(seenSessionHeaders.includes("sess-1"));
      await client.close();
    },
  );
});

test("config: user+project merge, project wins; save/remove", () => {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "avery-xdg-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "avery-proj-"));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    saveMcpServer("user", cwd, "shared", { command: "user-cmd" });
    saveMcpServer("user", cwd, "only-user", { command: "u" });
    saveMcpServer("project", cwd, "shared", { command: "project-cmd" });

    const merged = loadMcpServers(cwd);
    const byName = new Map(merged.map((s) => [s.name, s]));
    assert.equal(byName.get("shared")?.scope, "project");
    assert.equal(byName.get("shared")?.config.command, "project-cmd");
    assert.equal(byName.get("only-user")?.scope, "user");

    // user scope записан с 0600
    const mode = fs.statSync(userMcpPath()).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.ok(fs.existsSync(projectMcpPath(cwd)));

    assert.equal(removeMcpServer("project", cwd, "shared"), true);
    const after = loadMcpServers(cwd);
    // project-версия удалена → снова видна user-версия
    assert.equal(after.find((s) => s.name === "shared")?.scope, "user");
    assert.equal(removeMcpServer("project", cwd, "missing"), false);
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
    fs.rmSync(xdg, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
