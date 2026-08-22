import assert from "node:assert/strict";
import { test } from "node:test";
import { StreamMarkdown } from "../src/tui/markdown.ts";

// В тестах stdout — не TTY, поэтому ANSI-стили отключены и вывод — чистый текст.

test("buffers partial lines until newline", () => {
  const md = new StreamMarkdown();
  assert.equal(md.write("hel"), "");
  assert.equal(md.write("lo\nwor"), "hello\n");
  assert.equal(md.write("ld\n"), "world\n");
  assert.equal(md.flush(), "");
});

test("flush renders the tail without a newline", () => {
  const md = new StreamMarkdown();
  assert.equal(md.write("tail"), "");
  assert.equal(md.flush(), "tail\n");
});

test("headings, bullets, numbered lists, tasks", () => {
  const md = new StreamMarkdown();
  assert.equal(md.write("# Заголовок\n"), "Заголовок\n");
  assert.equal(md.write("- пункт\n"), "• пункт\n");
  assert.equal(md.write("2. второй\n"), "2. второй\n");
  assert.equal(md.write("- [x] сделано\n"), "☑ сделано\n");
  assert.equal(md.write("- [ ] todo\n"), "☐ todo\n");
});

test("code fences toggle raw code lines", () => {
  const md = new StreamMarkdown();
  assert.equal(md.write("```ts\n"), "```ts\n");
  // внутри блока markdown не применяется
  assert.equal(md.write("const **x** = 1;\n"), "  const **x** = 1;\n");
  assert.equal(md.write("```\n"), "```\n");
  // после закрытия снова обычный рендер
  assert.equal(md.write("**жирный**\n"), "жирный\n");
});

test("quotes and rules", () => {
  const md = new StreamMarkdown();
  const q = md.write("> цитата\n");
  assert.match(q, /│ цитата/);
  const r = md.write("---\n");
  assert.match(r, /─{10,}/);
});

test("inline code and bold render through renderInline", () => {
  const md = new StreamMarkdown();
  // без TTY стили — no-op, текст сохраняется без маркеров
  assert.equal(md.write("run `npm test` и **смотри**\n"), "run npm test и смотри\n");
});
