import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildEditPreview } from "../src/agent/preview.ts";
import { lineDiff } from "../src/tui/diff.ts";

// stdout в тестах — не TTY, стили отключены: вывод чистый текст.

test("lineDiff показывает изменённую середину с контекстом", () => {
  const out = lineDiff("a\nb\nc\nd\ne", "a\nb\nX\nY\ne");
  assert.match(out, /- c/);
  assert.match(out, /- d/);
  assert.match(out, /\+ X/);
  assert.match(out, /\+ Y/);
  assert.match(out, /^ {2}b$/m); // контекст до
  assert.match(out, /^ {2}e$/m); // контекст после
  assert.doesNotMatch(out, /- a/);
});

test("lineDiff: добавление в конец и удаление из конца", () => {
  assert.match(lineDiff("a\nb", "a\nb\nc"), /\+ c/);
  assert.match(lineDiff("a\nb\nc", "a\nb"), /- c/);
});

test("lineDiff: идентичный текст — «без изменений»", () => {
  assert.match(lineDiff("same", "same"), /без изменений/);
});

test("lineDiff режет огромные блоки с маркером", () => {
  const big = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
  const out = lineDiff("", big);
  assert.match(out, /ещё \d+ строк/);
});

test("buildEditPreview: новый файл — превью с +", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "avery-pv-"));
  try {
    const out = await buildEditPreview(
      "write_file",
      { path: "new.txt", content: "one\ntwo" },
      dir,
      false,
    );
    assert.match(out ?? "", /новый файл/);
    assert.match(out ?? "", /\+ one/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("buildEditPreview: перезапись существующего — дифф против текущего", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "avery-pv-"));
  try {
    await fs.writeFile(path.join(dir, "f.txt"), "old\nkeep\n", "utf8");
    const out = await buildEditPreview(
      "write_file",
      { path: "f.txt", content: "new\nkeep\n" },
      dir,
      false,
    );
    assert.match(out ?? "", /- old/);
    assert.match(out ?? "", /\+ new/);
    assert.match(out ?? "", /  keep/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("buildEditPreview: edit_file показывает дифф фрагмента", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "avery-pv-"));
  try {
    const out = await buildEditPreview(
      "edit_file",
      { path: "x.ts", old_string: "const a = 1", new_string: "const a = 2" },
      dir,
      false,
    );
    assert.match(out ?? "", /- const a = 1/);
    assert.match(out ?? "", /\+ const a = 2/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("buildEditPreview: остальные тулы и путь вне песочницы → undefined", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "avery-pv-"));
  try {
    assert.equal(
      await buildEditPreview("bash", { command: "ls" }, dir, false),
      undefined,
    );
    assert.equal(
      await buildEditPreview(
        "write_file",
        { path: "/etc/evil", content: "x" },
        dir,
        false,
      ),
      undefined,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
