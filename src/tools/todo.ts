import type { Tool } from "./index.ts";

export interface TodoItem {
  /** Что нужно сделать (в повелительной форме). */
  content: string;
  status: "pending" | "in_progress" | "done";
  /** Форма в настоящем времени для живого отображения, напр. «Пишу тесты». */
  activeForm?: string;
}

/** Session-scoped checklist store, keyed by cwd. Lives for the process. */
const store = new Map<string, TodoItem[]>();

const VALID_STATUSES = new Set(["pending", "in_progress", "done"]);

/** Current checklist for a cwd (empty array when nothing was set). */
export function getTodos(cwd: string): TodoItem[] {
  return store.get(cwd) ?? [];
}

export function renderTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return "(чеклист пуст)";
  return todos
    .map((t) => {
      if (t.status === "done") return `☑ ${t.content}`;
      if (t.status === "in_progress") return `▶ ${t.activeForm ?? t.content}`;
      return `☐ ${t.content}`;
    })
    .join("\n");
}

/**
 * todo_write — чеклист сессии для многошаговых задач (как TodoWrite в
 * Claude Code). Хранится в памяти процесса, файлы не трогает → kind "read",
 * разрешения не требует.
 */
export const todoWriteTool: Tool = {
  kind: "read",
  spec: {
    name: "todo_write",
    description:
      "Create and update the session task checklist. Use proactively for any task with 3+ distinct steps: break the work down, keep exactly one item in_progress, and mark items done immediately as you finish them. Always pass the FULL updated list — it replaces the previous one. Skip this tool for trivial single-step requests.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The full updated checklist (replaces the current one)",
          items: {
            type: "object",
            properties: {
              content: {
                type: "string",
                description: "What needs to be done, imperative (\"Run the tests\")",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "done"],
                description: "pending | in_progress (exactly one at a time) | done",
              },
              activeForm: {
                type: "string",
                description:
                  "Present-tense label shown while the item is in progress (\"Running the tests\")",
              },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
  },
  async execute(args, ctx) {
    const raw = Array.isArray(args.todos) ? (args.todos as unknown[]) : null;
    if (!raw) throw new Error("todos must be an array");
    const todos: TodoItem[] = raw.map((t, i) => {
      const item = (t ?? {}) as Record<string, unknown>;
      const content = String(item.content ?? "").trim();
      if (content.length === 0) {
        throw new Error(`todo #${i + 1}: content must not be empty`);
      }
      const status = String(item.status ?? "pending");
      if (!VALID_STATUSES.has(status)) {
        throw new Error(
          `todo #${i + 1} ("${content}"): unknown status "${status}" — use pending | in_progress | done`,
        );
      }
      const activeForm =
        typeof item.activeForm === "string" && item.activeForm.trim().length > 0
          ? item.activeForm.trim()
          : undefined;
      return {
        content,
        status: status as TodoItem["status"],
        ...(activeForm ? { activeForm } : {}),
      };
    });
    const inProgress = todos.filter((t) => t.status === "in_progress");
    if (inProgress.length > 1) {
      throw new Error(
        `Only ONE item may be in_progress (got ${inProgress.length}: ${inProgress
          .map((t) => `"${t.content}"`)
          .join(", ")})`,
      );
    }
    store.set(ctx.cwd, todos);
    return renderTodos(todos);
  },
};
