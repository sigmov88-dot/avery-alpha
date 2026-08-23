import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runAgentLoop } from "../src/agent/loop.ts";
import { makePermissionChecker } from "../src/agent/permissions.ts";
import type {
  ChatRequest,
  ChatStreamHandlers,
  ModelInfo,
  Provider,
} from "../src/provider/types.ts";
import {
  createSession,
  loadSession,
  saveSession,
} from "../src/session/index.ts";
import { bashTool } from "../src/tools/bash.ts";
import { readFileTool } from "../src/tools/readFile.ts";
import { taskTool } from "../src/tools/task.ts";
import { writeFileTool } from "../src/tools/writeFile.ts";

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
    return { finishReason: "stop" };
  }
}

test("plan mode: read allowed, write/execute отклоняются БЕЗ вопроса", async () => {
  let asked = 0;
  const check = makePermissionChecker({
    allow: [],
    mode: "plan",
    ask: async () => {
      asked++;
      return true;
    },
  });
  assert.equal(
    await check({ tool: "read_file", kind: "read", summary: "x" }),
    true,
  );
  assert.equal(
    await check({ tool: "write_file", kind: "write", summary: "x" }),
    false,
  );
  assert.equal(await check({ tool: "bash", kind: "execute", summary: "ls" }), false);
  assert.equal(asked, 0); // в plan-режиме не спрашиваем вовсе
});

test("accept-edits: правки проходят молча, выполнение — спрашивает", async () => {
  const asked: string[] = [];
  const check = makePermissionChecker({
    allow: [],
    mode: "accept-edits",
    ask: async (req) => {
      asked.push(req.tool);
      return true;
    },
  });
  assert.equal(
    await check({ tool: "write_file", kind: "write", summary: "a.ts" }),
    true,
  );
  assert.equal(
    await check({ tool: "edit_file", kind: "write", summary: "a.ts" }),
    true,
  );
  assert.equal(await check({ tool: "bash", kind: "execute", summary: "ls" }), true);
  assert.deepEqual(asked, ["bash"]); // спросили только про выполнение
});

test("plan mode: отказ объясняет режим в tool-сообщении", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "avery-plan-"));
  try {
    const provider = new ScriptedProvider({
      name: "write_file",
      arguments: { path: "x.txt", content: "y" },
    });
    const denied: string[] = [];
    const result = await runAgentLoop({
      provider,
      model: "m",
      messages: [{ role: "user", content: "сделай файл" }],
      tools: [writeFileTool],
      cwd: dir,
      maxIterations: 5,
      allow: [],
      mode: "plan",
      ask: async () => true, // не должен вызываться
      hooks: { onToolDenied: (c) => denied.push(c.name) },
    });
    const toolMsg = result.messages.find((m) => m.role === "tool");
    assert.match(toolMsg?.content ?? "", /plan mode is active/);
    assert.deepEqual(denied, ["write_file"]);
    assert.equal(
      await fs.stat(path.join(dir, "x.txt")).catch(() => null),
      null,
      "файл не должен быть создан",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("task: сабагент работает в своём контексте и только с read-тулами", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "avery-task-"));
  try {
    await fs.writeFile(path.join(dir, "note.txt"), "hello\n");
    const provider = new ScriptedProvider({
      name: "task",
      arguments: { prompt: "исследуй проект", description: "разведка проекта" },
    });
    const result = await runAgentLoop({
      provider,
      model: "m",
      messages: [{ role: "user", content: "посмотри что тут" }],
      tools: [taskTool, readFileTool, writeFileTool, bashTool],
      cwd: dir,
      maxIterations: 5,
      allow: [],
      mode: "auto",
      hooks: {},
    });
    // ответ сабагента вернулся как результат таска
    const toolMsg = result.messages.find((m) => m.role === "tool");
    assert.match(toolMsg?.content ?? "", /final answer/);
    // второй вызов провайдера — это сабагент: только read-тулы, без task
    const subCall = provider.calls[1];
    assert.ok(subCall, "сабагент должен был вызвать провайдера");
    const names = (subCall.tools ?? []).map((t) => t.name);
    assert.ok(!names.includes("task"), "нет рекурсии");
    assert.ok(!names.includes("write_file"), "без write");
    assert.ok(!names.includes("bash"), "без bash");
    // системный промпт сабагента — свой
    assert.match(
      String(subCall.messages[0]?.content ?? ""),
      /research subagent/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("task без runSubagent (вне агентного цикла) — понятная ошибка", async () => {
  await assert.rejects(
    () => taskTool.execute({ prompt: "x" }, { cwd: "/tmp" }),
    /not available/,
  );
});

function withTmpData(fn: () => void): void {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "avery-modes-"));
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dir;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prev;
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
}

test("режим разрешений переживает сохранение сессии", () => {
  withTmpData(() => {
    const s = createSession("/x", "m");
    s.mode = "plan";
    saveSession(s);
    assert.equal(loadSession(s.id)?.mode, "plan");
  });
});
