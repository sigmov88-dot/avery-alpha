import type { Tool } from "./index.ts";

/**
 * task — read-only сабагент для фоновых исследований (как Agent/Explore в
 * Claude Code). Работает в собственном контекстном окне: ему доступны только
 * read-тулы родителя (без рекурсии), поэтому kind "read" — разрешений не
 * требует. Реализация запуска — в agent loop (ctx.runSubagent).
 */
export const taskTool: Tool = {
  kind: "read",
  spec: {
    name: "task",
    description:
      "Launch a read-only subagent to research the codebase in its own context window, then return its findings. Use for open-ended exploration (\"where is X handled?\", \"how does the auth flow work?\") instead of many manual searches — it keeps this conversation's context clean. The subagent has only the read tools (read_file/ls/glob/grep): it cannot modify files or run commands. Do NOT use it for code changes.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "What to research — a self-contained question or task for the subagent",
        },
        description: {
          type: "string",
          description: "Short 3-5 word label shown in the UI",
        },
      },
      required: ["prompt"],
    },
  },
  async execute(args, ctx) {
    if (!ctx.runSubagent) {
      throw new Error("subagents are not available in this mode");
    }
    const prompt = String(args.prompt ?? "").trim();
    if (prompt.length === 0) throw new Error("prompt must not be empty");
    return ctx.runSubagent(prompt, ctx);
  },
};
