import assert from "node:assert/strict";
import { test } from "node:test";
import { highlightCode } from "../src/tui/highlight.ts";
import {
  MASCOT_NAME,
  mascotFace,
  mascotLines,
  THINK_FRAMES,
} from "../src/tui/mascot.ts";
import { StreamMarkdown } from "../src/tui/markdown.ts";

// stdout в тестах — не TTY, стили отключены: вывод — чистый текст.

test("маскот Avi: настроения различаются, арт — 4 строки, в кадрах есть моргание", () => {
  assert.equal(MASCOT_NAME, "Avi");
  assert.notEqual(mascotFace("idle"), mascotFace("blink"));
  assert.notEqual(mascotFace("happy"), mascotFace("error"));
  assert.equal(mascotLines().length, 4);
  assert.ok(mascotLines("work")[1]?.includes("⚡"));
  assert.ok(THINK_FRAMES.length >= 4);
  assert.ok(THINK_FRAMES.includes("(-v-)"));
});

test("highlight: на не-TTY текст проходит без изменений и без ANSI", () => {
  const line = 'const x = "return"; // comment';
  assert.equal(highlightCode(line, "ts"), line);
  assert.equal(highlightCode('{"a": 1, "b": true}', "json"), '{"a": 1, "b": true}');
  assert.equal(highlightCode("print('hi')  # привет", "python"), "print('hi')  # привет");
  // неизвестный язык — безопасный проход
  assert.equal(highlightCode(">+<[.]", "brainfuck"), ">+<[.]");
  // строка с // не ломается комментарием (левейшая альтернатива побеждает)
  const url = 'const u = "https://example.com";';
  assert.equal(highlightCode(url, "ts"), url);
});

test("markdown: pipe-таблица рендерится выровненными колонками", () => {
  const md = new StreamMarkdown();
  const out = md.write(
    "| name | value |\n| --- | --- |\n| a | 22 |\nпосле таблицы\n",
  );
  assert.match(out, /name/);
  assert.match(out, /value/);
  assert.match(out, /─+/); // разделитель заголовка
  assert.match(out, /a\s+│?\s*22/); // строка данных
  assert.match(out, /после таблицы/); // текст после таблицы не потерян
  assert.doesNotMatch(out, /\| --- \|/); // сырая разметка не протекает
});

test("markdown: буферизованная таблица дорендеривается на flush", () => {
  const md = new StreamMarkdown();
  md.write("| x | y |\n| - | - |\n| 1 | 2 |\n");
  const out = md.flush();
  assert.match(out, /x/);
  assert.match(out, /1/);
});

test("markdown: код в фенсе подсвечивается без поломки текста (non-TTY passthrough)", () => {
  const md = new StreamMarkdown();
  const out = md.write("```ts\nconst a = 1;\n```\n");
  assert.match(out, /const a = 1;/);
});
