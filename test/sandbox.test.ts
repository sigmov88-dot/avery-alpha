import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { editFileTool } from "../src/tools/editFile.ts";
import { globTool } from "../src/tools/glob.ts";
import { grepTool } from "../src/tools/grep.ts";
import { lsTool } from "../src/tools/ls.ts";
import { readFileTool } from "../src/tools/readFile.ts";
import { writeFileTool } from "../src/tools/writeFile.ts";
import { resolveInCwd } from "../src/util/fsx.ts";

async function withDirs(
  fn: (root: string, outside: string) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "avery-sbx-root-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "avery-sbx-out-"));
  try {
    await fn(root, outside);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
}

test("resolveInCwd: пути внутри проекта разрешены", async () => {
  await withDirs(async (root) => {
    assert.equal(await resolveInCwd(root, "src/a.ts"), path.join(root, "src/a.ts"));
    assert.equal(await resolveInCwd(root, "."), root);
    assert.equal(
      await resolveInCwd(root, "sub/../file.txt"),
      path.join(root, "file.txt"),
    );
  });
});

test("resolveInCwd: .. и абсолютные пути наружу запрещены", async () => {
  await withDirs(async (root, outside) => {
    await assert.rejects(
      () => resolveInCwd(root, "../escape.txt"),
      /escapes the project/,
    );
    await assert.rejects(
      () => resolveInCwd(root, path.join(outside, "x.txt")),
      /escapes the project/,
    );
    // новый файл в несуществующих подкаталогах — можно, если внутри корня
    assert.equal(
      await resolveInCwd(root, "deep/nested/new.txt"),
      path.join(root, "deep/nested/new.txt"),
    );
  });
});

test("resolveInCwd: symlink-выход из проекта заблокирован (даже для новых файлов)", async () => {
  await withDirs(async (root, outside) => {
    await fs.writeFile(path.join(outside, "secret.txt"), "shh");
    await fs.symlink(outside, path.join(root, "link"));
    await assert.rejects(
      () => resolveInCwd(root, "link/secret.txt"),
      /escapes the project/,
    );
    await assert.rejects(
      () => resolveInCwd(root, "link/brand-new.txt"),
      /escapes the project/,
    );
    // allowOutside снимает ограничение
    assert.equal(
      await resolveInCwd(root, "link/secret.txt", { allowOutside: true }),
      path.join(root, "link/secret.txt"),
    );
  });
});

test("read_file/write_file/edit_file/ls/glob/grep не выходят из cwd", async () => {
  await withDirs(async (root, outside) => {
    const secret = path.join(outside, "s.txt");
    await fs.writeFile(secret, "secret data");

    await assert.rejects(
      () => readFileTool.execute({ path: secret }, { cwd: root }),
      /escapes the project/,
    );
    await assert.rejects(
      () =>
        writeFileTool.execute(
          { path: path.join(outside, "w.txt"), content: "x" },
          { cwd: root },
        ),
      /escapes the project/,
    );
    await assert.rejects(
      () =>
        editFileTool.execute(
          { path: secret, old_string: "secret", new_string: "x" },
          { cwd: root },
        ),
      /escapes the project/,
    );
    await assert.rejects(
      () => lsTool.execute({ path: outside }, { cwd: root }),
      /escapes the project/,
    );
    await assert.rejects(
      () => globTool.execute({ pattern: "*.txt", path: outside }, { cwd: root }),
      /escapes the project/,
    );
    await assert.rejects(
      () => grepTool.execute({ pattern: "secret", path: outside }, { cwd: root }),
      /escapes the project/,
    );

    // внутри проекта — как обычно
    await writeFileTool.execute({ path: "ok.txt", content: "fine" }, { cwd: root });
    assert.equal(await fs.readFile(path.join(root, "ok.txt"), "utf8"), "fine");

    // allowOutsideCwd: true — чтение снаружи работает
    const out = await readFileTool.execute(
      { path: secret },
      { cwd: root, allowOutsideCwd: true },
    );
    assert.match(out, /secret data/);
  });
});
