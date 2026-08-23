import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildSystemPrompt, loadProjectInstructions } from "../src/agent/prompt.ts";

test("системный промпт содержит ключевые секции", () => {
  const p = buildSystemPrompt({ cwd: "/x", model: "m" });
  for (const marker of [
    "Tone and style",
    "Tool discipline",
    "Task management",
    "todo_write",
    "Git discipline",
    "Safety",
    "Working directory: /x",
    "Platform:",
  ]) {
    assert.ok(p.includes(marker), `missing: ${marker}`);
  }
});

test("AVERY.md подхватывается в промпт, AGENTS.md — фолбэк", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "avery-prompt-"));
  try {
    assert.equal(loadProjectInstructions(dir), undefined);
    fs.writeFileSync(path.join(dir, "AVERY.md"), "правило: тесты обязательны");
    assert.match(
      buildSystemPrompt({ cwd: dir, model: "m" }),
      /правило: тесты обязательны/,
    );
    fs.rmSync(path.join(dir, "AVERY.md"));
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "agents fallback");
    assert.match(loadProjectInstructions(dir) ?? "", /agents fallback/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP-серверы попадают в промпт", () => {
  const p = buildSystemPrompt({ cwd: "/x", model: "m", mcpServers: ["fs", "web"] });
  assert.match(p, /mcp__<server>__<tool>/);
  assert.match(p, /fs, web/);
});
