#!/usr/bin/env node
/**
 * End-to-end smoke test: spins up a mock OpenCode ZEN server and drives the
 * real CLI (node src/cli.ts) through config → models → run (deny) → run (--yes)
 * → MCP (add → test → run with an MCP tool).
 *
 * Uses async spawn (spawnSync can deadlock with networked children in some
 * sandboxed environments).
 *
 * Usage: node scripts/e2e.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const CLI = path.resolve(import.meta.dirname, "../src/cli.ts");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "avery-e2e-"));
const projectDir = path.join(tmp, "project");
fs.mkdirSync(projectDir, { recursive: true });

const env = {
  ...process.env,
  XDG_CONFIG_HOME: path.join(tmp, "config"),
  XDG_DATA_HOME: path.join(tmp, "data"),
  OPENCODE_API_KEY: "e2e-key",
  NO_COLOR: "1",
  CI: "true",
};

function run(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env,
      encoding: "utf8",
      ...opts,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

// ---------------------------------------------------------------- mock ZEN
// Заголовки /models записываем, а проверяем в шагах: ZEN шлёт ключ,
// кастомный провайдер без ключа — нет (это валидно для локальных серверов).
const modelsAuthHeaders = [];

const zenServer = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/models") {
    modelsAuthHeaders.push(req.headers.authorization);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        data: [{ id: "big-pickle" }, { id: "test-model", context_length: 200000 }],
      }),
    );
    return;
  }
  if (req.method === "POST" && req.url === "/chat/completions") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const hasToolResult = parsed.messages.some((m) => m.role === "tool");
      const sawMcpTool = (parsed.tools ?? []).some((t) =>
        t.function?.name?.startsWith("mcp__"),
      );
      res.setHeader("content-type", "text/event-stream");
      if (sawMcpTool && !hasToolResult) {
        // Второй сценарий: модель вызывает MCP-инструмент
        const args = JSON.stringify({ text: "mcp works" });
        res.end(
          [
            `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_mcp","function":{"name":"mcp__e2emock__echo","arguments":${JSON.stringify(args)}}}]}}]}`,
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":4}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
        );
      } else if (!hasToolResult) {
        const args = JSON.stringify({
          path: "e2e.txt",
          content: "hello from avery e2e",
        });
        res.end(
          [
            `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_e2e","function":{"name":"write_file","arguments":${JSON.stringify(args)}}}]}}]}`,
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":4}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
        );
      } else {
        const mcpEcho = parsed.messages.some(
          (m) => m.role === "tool" && String(m.content).includes("echo:mcp works"),
        );
        res.end(
          [
            `data: {"choices":[{"delta":{"content":"${mcpEcho ? "E2E-OK: mcp tool called" : "E2E-OK: file created"}"}}]}`,
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":30,"completion_tokens":6}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
        );
      }
    });
    return;
  }
  res.statusCode = 404;
  res.end("{}");
});

await new Promise((resolve) => zenServer.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${zenServer.address().port}`;

let failed = false;
async function step(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failed = true;
    console.error(`✗ ${name}`);
    console.error(e);
  }
}

try {
  await step("avery --version", async () => {
    const r = await run(["--version"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /0\.6\.0/);
  });

  await step("avery --help", async () => {
    const r = await run(["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /auth login/);
    assert.match(r.stdout, /OPENCODE_API_KEY/);
    assert.match(r.stdout, /mcp add/);
    assert.match(r.stdout, /ANTHROPIC_API_KEY/);
  });

  await step("config set baseUrl → mock server", async () => {
    const r = await run(["config", "set", "baseUrl", base]);
    assert.equal(r.status, 0, r.stderr);
    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmp, "config/avery/config.json"), "utf8"),
    );
    assert.equal(cfg.baseUrl, base);
  });

  await step("models lists the mock catalog", async () => {
    const r = await run(["models"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /big-pickle/);
    assert.match(r.stdout, /test-model/);
    // ZEN-провайдер отправляет сохранённый ключ
    assert.ok(modelsAuthHeaders.includes("Bearer e2e-key"));
  });

  await step("run without --yes denies the write (file NOT created)", async () => {
    const r = await run(["run", "create a file", "--cwd", projectDir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /E2E-OK/);
    assert.match(r.stderr, /--yes/);
    assert.equal(fs.existsSync(path.join(projectDir, "e2e.txt")), false);
  });

  await step("run --yes executes write_file end to end", async () => {
    const r = await run(["run", "create a file", "--yes", "--verbose", "--cwd", projectDir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /E2E-OK: file created/);
    assert.match(r.stderr, /write_file/);
    assert.equal(
      fs.readFileSync(path.join(projectDir, "e2e.txt"), "utf8"),
      "hello from avery e2e",
    );
  });

  await step("session was persisted for the project", async () => {
    const dir = path.join(tmp, "data/avery/sessions");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.ok(files.length >= 1);
    const s = JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8"));
    assert.equal(s.cwd, projectDir);
    assert.ok(s.messages.some((m) => m.role === "tool"));
  });

  // ------------------------------------------------------------------ MCP
  await step("mcp add registers a stdio server", async () => {
    const fixture = path.resolve(import.meta.dirname, "../test/fixtures/mock-mcp-server.mjs");
    const r = await run(["mcp", "add", "e2emock", process.execPath, fixture]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /e2emock/);
    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmp, "config/avery/mcp.json"), "utf8"),
    );
    assert.ok(cfg.mcpServers?.e2emock?.command);
  });

  await step("mcp list shows the server", async () => {
    const r = await run(["mcp", "list"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /e2emock/);
  });

  await step("mcp test connects and lists tools", async () => {
    const r = await run(["mcp", "test", "e2emock"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /mcp__e2emock__echo/);
  });

  await step("agent calls the MCP tool end to end", async () => {
    const r = await run(["run", "use the echo tool", "--yes", "--cwd", projectDir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /E2E-OK: mcp tool called/);
  });

  await step("mcp remove deletes the server", async () => {
    const r = await run(["mcp", "remove", "e2emock"]);
    assert.equal(r.status, 0, r.stderr);
    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmp, "config/avery/mcp.json"), "utf8"),
    );
    assert.equal(cfg.mcpServers.e2emock, undefined);
  });

  // ------------------------------------------------------ custom providers
  await step("provider add registers a custom provider", async () => {
    const r = await run([
      "provider",
      "add",
      "mocklocal",
      "--url",
      base,
      "--model",
      "big-pickle",
    ]);
    assert.equal(r.status, 0, r.stderr);
    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmp, "config/avery/config.json"), "utf8"),
    );
    assert.equal(cfg.customProviders?.mocklocal?.baseUrl, base);
  });

  await step("custom provider is usable via --provider", async () => {
    const r2 = await run(["models", "--provider", "mocklocal"]);
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stdout, /big-pickle/);
    // провайдер без ключа не отправляет authorization
    assert.equal(modelsAuthHeaders[modelsAuthHeaders.length - 1], undefined);
  });
} finally {
  zenServer.closeAllConnections();
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 500);
    zenServer.close(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

fs.rmSync(tmp, { recursive: true, force: true });

if (failed) {
  console.error("\nE2E FAILED");
  process.exit(1);
}
console.log("\nE2E PASSED");
