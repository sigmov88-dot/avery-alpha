import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { bashTool } from "../src/tools/bash.ts";
import { editFileTool } from "../src/tools/editFile.ts";
import { globTool } from "../src/tools/glob.ts";
import { grepTool } from "../src/tools/grep.ts";
import { lsTool } from "../src/tools/ls.ts";
import { readFileTool } from "../src/tools/readFile.ts";
import { writeFileTool } from "../src/tools/writeFile.ts";

let dir: string;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "avery-test-"));
  await fs.mkdir(path.join(dir, "src/nested"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "src/index.ts"),
    "export const a = 1;\nconsole.log(a);\n",
  );
  await fs.writeFile(
    path.join(dir, "src/nested/deep.txt"),
    "hello\nworld\nhello again\n",
  );
  await fs.writeFile(path.join(dir, "README.md"), "# Test\n");
});

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

test("write_file creates parent directories and content", async () => {
  const r = await writeFileTool.execute(
    { path: "new/dir/file.txt", content: "abc" },
    { cwd: dir },
  );
  assert.match(r, /Created/);
  assert.equal(await fs.readFile(path.join(dir, "new/dir/file.txt"), "utf8"), "abc");
});

test("write_file overwrites existing files", async () => {
  const r = await writeFileTool.execute(
    { path: "README.md", content: "# Changed\n" },
    { cwd: dir },
  );
  assert.match(r, /Overwrote/);
  assert.equal(await fs.readFile(path.join(dir, "README.md"), "utf8"), "# Changed\n");
});

test("read_file returns numbered lines", async () => {
  const r = await readFileTool.execute({ path: "src/nested/deep.txt" }, { cwd: dir });
  assert.match(r, /1\thello/);
  assert.match(r, /3\thello again/);
});

test("read_file errors on missing file and on directories", async () => {
  await assert.rejects(
    () => readFileTool.execute({ path: "nope.txt" }, { cwd: dir }),
    /not found/i,
  );
  await assert.rejects(
    () => readFileTool.execute({ path: "src" }, { cwd: dir }),
    /directory/,
  );
});

test("edit_file replaces a unique match", async () => {
  const r = await editFileTool.execute(
    { path: "src/index.ts", old_string: "a = 1", new_string: "a = 2" },
    { cwd: dir },
  );
  assert.match(r, /replaced 1/);
  assert.match(await fs.readFile(path.join(dir, "src/index.ts"), "utf8"), /a = 2/);
});

test("edit_file rejects ambiguous matches unless replace_all", async () => {
  await assert.rejects(
    () =>
      editFileTool.execute(
        { path: "src/nested/deep.txt", old_string: "hello", new_string: "hi" },
        { cwd: dir },
      ),
    /2 locations/,
  );
  const r = await editFileTool.execute(
    {
      path: "src/nested/deep.txt",
      old_string: "hello",
      new_string: "hi",
      replace_all: true,
    },
    { cwd: dir },
  );
  assert.match(r, /replaced 2/);
});

test("edit_file errors when old_string is absent", async () => {
  await assert.rejects(
    () =>
      editFileTool.execute(
        { path: "src/index.ts", old_string: "zzz-not-here", new_string: "x" },
        { cwd: dir },
      ),
    /not found/,
  );
});

test("glob matches ** patterns relative to base", async () => {
  const r = await globTool.execute({ pattern: "src/**/*.ts" }, { cwd: dir });
  assert.match(r, /src\/index\.ts/);
  assert.doesNotMatch(r, /deep\.txt/);
});

test("grep returns file:line matches", async () => {
  const r = await grepTool.execute({ pattern: "world", path: "src" }, { cwd: dir });
  assert.match(r, /deep\.txt:2: world/);
});

test("grep validates the regex", async () => {
  await assert.rejects(
    () => grepTool.execute({ pattern: "([" }, { cwd: dir }),
    /Invalid regex/,
  );
});

test("ls lists directories first and marks them with /", async () => {
  const r = await lsTool.execute({ path: "." }, { cwd: dir });
  assert.match(r, /src\//);
  assert.match(r, /README\.md/);
  assert.ok(r.indexOf("src/") < r.indexOf("README.md"));
});

test("bash runs commands and reports exit codes without throwing", async () => {
  const ok = await bashTool.execute({ command: "echo hello-avery" }, { cwd: dir });
  assert.equal(ok, "hello-avery");
  const bad = await bashTool.execute({ command: "exit 3" }, { cwd: dir });
  assert.match(bad, /exit code 3/);
});
