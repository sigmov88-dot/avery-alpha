import assert from "node:assert/strict";
import { test } from "node:test";
import { getTodos, todoWriteTool } from "../src/tools/todo.ts";

const CTX = (cwd: string) => ({ cwd });

test("todo_write валидирует и рендерит чеклист", async () => {
  const out = await todoWriteTool.execute(
    {
      todos: [
        { content: "Разобраться в коде", status: "done" },
        { content: "Написать фичу", status: "in_progress", activeForm: "Пишу фичу" },
        { content: "Прогнать тесты", status: "pending" },
      ],
    },
    CTX("/tmp/avery-todo-a"),
  );
  assert.match(out, /☑ Разобраться/);
  assert.match(out, /▶ Пишу фичу/);
  assert.match(out, /☐ Прогнать тесты/);
  assert.equal(getTodos("/tmp/avery-todo-a").length, 3);
});

test("ровно один in_progress — иначе понятная ошибка", async () => {
  await assert.rejects(
    () =>
      todoWriteTool.execute(
        {
          todos: [
            { content: "a", status: "in_progress" },
            { content: "b", status: "in_progress" },
          ],
        },
        CTX("/tmp/avery-todo-b"),
      ),
    /Only ONE item/,
  );
});

test("неизвестный статус и пустой content — ошибки с подсказкой", async () => {
  await assert.rejects(
    () =>
      todoWriteTool.execute(
        { todos: [{ content: "x", status: "doing" }] },
        CTX("/tmp/avery-todo-c"),
      ),
    /unknown status/,
  );
  await assert.rejects(
    () =>
      todoWriteTool.execute(
        { todos: [{ content: "  ", status: "pending" }] },
        CTX("/tmp/avery-todo-c"),
      ),
    /must not be empty/,
  );
});

test("список заменяется целиком и изолирован по cwd", async () => {
  await todoWriteTool.execute(
    { todos: [{ content: "only one", status: "pending" }] },
    CTX("/tmp/avery-todo-d"),
  );
  await todoWriteTool.execute({ todos: [] }, CTX("/tmp/avery-todo-d"));
  assert.equal(getTodos("/tmp/avery-todo-d").length, 0);
  assert.equal(getTodos("/tmp/avery-todo-unrelated").length, 0);
});

test("kind read — разрешений не требует", () => {
  assert.equal(todoWriteTool.kind, "read");
});
