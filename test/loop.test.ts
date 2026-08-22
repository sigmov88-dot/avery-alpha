import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runAgentLoop, summarizeArgs } from "../src/agent/loop.ts";
import { compileRule, makePermissionChecker } from "../src/agent/permissions.ts";
import type {
  ChatRequest,
  ChatStreamHandlers,
  ModelInfo,
  Provider,
} from "../src/provider/types.ts";
import { bashTool } from "../src/tools/bash.ts";
import { readFileTool } from "../src/tools/readFile.ts";

/** Provider that requests one tool call on the first turn, then answers. */
class ScriptedProvider implements Provider {
  readonly name = "fake";
  calls: ChatRequest[] = [];
  private readonly toolCall: {
    name: string;
    arguments: Record<string, unknown>;
  } | null;

  constructor(toolCall: {
    name: string;
    arguments: Record<string, unknown>;
  } | null) {
    this.toolCall = toolCall;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  async streamChat(
    request: ChatRequest,
    handlers: ChatStreamHandlers,
  ): Promise<{ finishReason: string }> {
    this.calls.push(request);
    if (this.calls.length === 1 && this.toolCall) {
      handlers.onToolCall?.({
        id: "c1",
        name: this.toolCall.name,
        arguments: JSON.stringify(this.toolCall.arguments),
      });
      return { finishReason: "tool_calls" };
    }
    handlers.onText?.("final answer");
    handlers.onUsage?.({ inputTokens: 3, outputTokens: 2 });
    return { finishReason: "stop" };
  }
}

test("agent loop executes tool calls and threads results back", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "avery-loop-"));
  try {
    await fs.writeFile(path.join(dir, "note.txt"), "hello note\n");
    const provider = new ScriptedProvider({
      name: "read_file",
      arguments: { path: "note.txt" },
    });
    const events: string[] = [];
    const result = await runAgentLoop({
      provider,
      model: "m",
      messages: [{ role: "user", content: "read note.txt" }],
      tools: [readFileTool],
      cwd: dir,
      maxIterations: 5,
      allow: [],
      mode: "auto",
      hooks: {
        onText: (t) => events.push(`text:${t}`),
        onToolStart: (c) => events.push(`start:${c.name}`),
        onToolResult: (_c, r, isError) =>
          events.push(`result:${isError ? "err" : "ok"}`),
      },
    });

    assert.equal(result.stopReason, "done");
    assert.equal(provider.calls.length, 2);

    // final history: user → assistant(tool call) → tool(result) → assistant(text)
    const history = result.messages;
    assert.equal(history[1]?.role, "assistant");
    assert.equal(history[1]?.toolCalls?.[0]?.name, "read_file");
    assert.equal(history[2]?.role, "tool");
    assert.match(history[2]?.content ?? "", /hello note/);
    assert.equal(history[3]?.role, "assistant");
    assert.equal(history[3]?.content, "final answer");

    assert.deepEqual(result.usage, {
      inputTokens: 3,
      outputTokens: 2,
      cost: undefined,
    });
    assert.ok(events.includes("start:read_file"));
    assert.ok(events.includes("result:ok"));
    assert.ok(events.includes("text:final answer"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("auto mode denies non-allowlisted execute tools", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "avery-loop-"));
  try {
    const provider = new ScriptedProvider({
      name: "bash",
      arguments: { command: "echo should-not-run" },
    });
    const denied: string[] = [];
    const result = await runAgentLoop({
      provider,
      model: "m",
      messages: [{ role: "user", content: "x" }],
      tools: [bashTool],
      cwd: dir,
      maxIterations: 5,
      allow: [],
      mode: "auto",
      hooks: { onToolDenied: (c) => denied.push(c.name) },
    });
    assert.deepEqual(denied, ["bash"]);
    const toolMsg = result.messages.find((m) => m.role === "tool");
    assert.match(toolMsg?.content ?? "", /permission denied/);
    assert.equal(result.stopReason, "done");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("allowlist rule permits matching commands", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "avery-loop-"));
  try {
    const provider = new ScriptedProvider({
      name: "bash",
      arguments: { command: "echo allowed-hi" },
    });
    const result = await runAgentLoop({
      provider,
      model: "m",
      messages: [{ role: "user", content: "x" }],
      tools: [bashTool],
      cwd: dir,
      maxIterations: 5,
      allow: ["bash:echo *"],
      mode: "auto",
      hooks: {},
    });
    const toolMsg = result.messages.find((m) => m.role === "tool");
    assert.match(toolMsg?.content ?? "", /allowed-hi/);
    assert.doesNotMatch(toolMsg?.content ?? "", /permission denied/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("unknown tools produce an error tool message, not a crash", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "avery-loop-"));
  try {
    const provider = new ScriptedProvider({
      name: "nonsense_tool",
      arguments: {},
    });
    const result = await runAgentLoop({
      provider,
      model: "m",
      messages: [{ role: "user", content: "x" }],
      tools: [readFileTool],
      cwd: dir,
      maxIterations: 5,
      allow: [],
      mode: "auto",
      hooks: {},
    });
    const toolMsg = result.messages.find((m) => m.role === "tool");
    assert.match(toolMsg?.content ?? "", /unknown tool/);
    assert.equal(result.stopReason, "done");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("kind-alias rules: write: matches write_file/edit_file (как в README)", async () => {
  const check = makePermissionChecker({ allow: ["write:src/**"], mode: "auto" });
  assert.equal(
    await check({ tool: "write_file", kind: "write", summary: "src/a/b.ts" }),
    true,
  );
  assert.equal(
    await check({ tool: "edit_file", kind: "write", summary: "src/a/b.ts" }),
    true,
  );
  // вне паттерна — нельзя, другой kind — нельзя
  assert.equal(
    await check({ tool: "write_file", kind: "write", summary: "etc/passwd" }),
    false,
  );
  assert.equal(
    await check({ tool: "bash", kind: "execute", summary: "src/a.ts" }),
    false,
  );
});

test("compileRule matches tool:summary targets", () => {
  assert.equal(compileRule("bash:git *")("bash:git status"), true);
  assert.equal(compileRule("bash:git *")("bash:rm x"), false);
  assert.equal(compileRule("write:src/**")("write:src/a/b.ts"), true);
  assert.equal(compileRule("write:src/**")("write:README.md"), false);
  assert.equal(compileRule("bash:*")("bash:anything at all"), true);
});

test("permission checker: read tools always pass; ask handler is consulted", async () => {
  const asked: string[] = [];
  const check = makePermissionChecker({
    allow: [],
    mode: "ask",
    ask: async (req) => {
      asked.push(req.tool);
      return req.tool === "write_file";
    },
  });
  assert.equal(await check({ tool: "read_file", kind: "read", summary: "x" }), true);
  assert.equal(await check({ tool: "write_file", kind: "write", summary: "x" }), true);
  assert.equal(await check({ tool: "bash", kind: "execute", summary: "ls" }), false);
  assert.deepEqual(asked, ["write_file", "bash"]);
});

test("summarizeArgs produces compact per-tool summaries", () => {
  assert.equal(summarizeArgs("read_file", { path: "a.ts" }), "a.ts");
  assert.equal(summarizeArgs("bash", { command: "ls -la" }), "ls -la");
  assert.equal(summarizeArgs("ls", {}), ".");
});
