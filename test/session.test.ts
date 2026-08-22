import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createSession,
  latestSession,
  listSessions,
  saveSession,
  sessionPath,
} from "../src/session/index.ts";

function withTmpData(fn: () => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "avery-sess-"));
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dir;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("listSessions матчит cwd без учёта завершающего слэша", () => {
  withTmpData(() => {
    const a = createSession("/proj", "m");
    saveSession(a);
    const b = createSession("/other", "m");
    saveSession(b);
    assert.equal(listSessions("/proj/").length, 1);
    assert.equal(listSessions("/proj").length, 1);
    assert.equal(latestSession("/proj/")?.id, a.id);
    assert.equal(listSessions("/other").length, 1);
  });
});

test("файл сессии пишется с правами 0600, title из первого user-сообщения", () => {
  withTmpData(() => {
    const s = createSession("/x", "m");
    s.messages.push({ role: "user", content: "  сделай   мне\nфичу " });
    saveSession(s);
    assert.equal(s.title, "сделай мне фичу");
    const mode = fs.statSync(sessionPath(s.id)).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});
