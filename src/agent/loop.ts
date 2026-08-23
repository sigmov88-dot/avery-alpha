import type {
  ChatMessage,
  Provider,
  ToolCall,
  Usage,
} from "../provider/types.ts";
import { toSpecs, type Tool, type ToolContext } from "../tools/index.ts";
import {
  makePermissionChecker,
  type PermissionHandler,
  type PermissionMode,
} from "./permissions.ts";
import { buildEditPreview } from "./preview.ts";

export interface AgentHooks {
  onText?: (text: string) => void;
  onToolStart?: (call: ToolCall, summary: string) => void;
  onToolResult?: (call: ToolCall, result: string, isError: boolean) => void;
  onToolDenied?: (call: ToolCall) => void;
  onUsage?: (usage: Usage) => void;
}

export interface AgentLoopOptions {
  provider: Provider;
  model: string;
  messages: ChatMessage[];
  tools: Tool[];
  cwd: string;
  maxIterations: number;
  allow: string[];
  mode: PermissionMode;
  /** Песочница путей: false (дефолт) — файловые тулы заперты в cwd. */
  allowOutsideCwd?: boolean;
  ask?: PermissionHandler;
  signal?: AbortSignal;
  hooks: AgentHooks;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number | undefined;
}

export interface AgentLoopResult {
  messages: ChatMessage[];
  stopReason: "done" | "max-iterations" | "aborted";
  usage: AgentUsage;
}

/** Short display string for a tool invocation. */
export function summarizeArgs(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "read_file":
    case "write_file":
    case "edit_file":
      return String(args.path ?? "");
    case "bash":
      return String(args.command ?? "");
    case "ls":
      return String(args.path ?? ".");
    case "glob":
      return String(args.pattern ?? "");
    case "grep":
      return `${args.pattern ?? ""} ${args.path ?? ""}`.trim();
    case "todo_write": {
      const n = Array.isArray(args.todos) ? args.todos.length : 0;
      return `${n} пунктов в чеклисте`;
    }
    case "task":
      return String(args.description ?? args.prompt ?? "").slice(0, 80);
    default:
      return JSON.stringify(args).slice(0, 120);
  }
}

const MAX_TOOL_RESULT = 100_000;

/** Cap tool results; the marker tells the model the content is incomplete. */
function truncateToolResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT) return result;
  return (
    result.slice(0, MAX_TOOL_RESULT) +
    `\n[result truncated at ${MAX_TOOL_RESULT} characters — narrow the query or read a smaller range]`
  );
}

export async function runAgentLoop(
  opts: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const check = makePermissionChecker({
    allow: opts.allow,
    mode: opts.mode,
    ask: opts.ask,
  });
  const messages = [...opts.messages];
  const usage: AgentUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cost: undefined,
  };

  for (let iter = 0; iter < opts.maxIterations; iter++) {
    if (opts.signal?.aborted) {
      return { messages, stopReason: "aborted", usage };
    }

    let text = "";
    const calls: ToolCall[] = [];
    await opts.provider.streamChat(
      {
        model: opts.model,
        messages,
        tools: opts.tools.length > 0 ? toSpecs(opts.tools) : undefined,
        signal: opts.signal,
      },
      {
        onText: (t) => {
          text += t;
          opts.hooks.onText?.(t);
        },
        onToolCall: (c) => calls.push(c),
        onUsage: (u) => {
          usage.inputTokens += u.inputTokens;
          usage.outputTokens += u.outputTokens;
          if (u.cost !== undefined) usage.cost = (usage.cost ?? 0) + u.cost;
          opts.hooks.onUsage?.(u);
        },
      },
    );

    messages.push({
      role: "assistant",
      content: text.length > 0 ? text : null,
      toolCalls: calls.length > 0 ? calls : undefined,
    });

    if (calls.length === 0) {
      return { messages, stopReason: "done", usage };
    }

    for (const call of calls) {
      if (opts.signal?.aborted) {
        return { messages, stopReason: "aborted", usage };
      }
      const tool = opts.tools.find((t) => t.spec.name === call.name);
      if (!tool) {
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: `Error: unknown tool "${call.name}". Available: ${opts.tools.map((t) => t.spec.name).join(", ")}`,
        });
        continue;
      }

      let args: Record<string, unknown> = {};
      try {
        args = call.arguments
          ? (JSON.parse(call.arguments) as Record<string, unknown>)
          : {};
      } catch (e) {
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: `Error: invalid tool arguments JSON: ${(e as Error).message}`,
        });
        continue;
      }

      const summary = summarizeArgs(tool.spec.name, args);
      // В интерактивном режиме для write/edit собираем визуальный дифф —
      // пользователь видит изменение до подтверждения, а не вслепую.
      const preview =
        opts.mode === "ask" && opts.ask
          ? await buildEditPreview(
              tool.spec.name,
              args,
              opts.cwd,
              opts.allowOutsideCwd === true,
            )
          : undefined;
      const allowed = await check({
        tool: tool.spec.name,
        kind: tool.kind,
        summary,
        preview,
      });
      if (!allowed) {
        opts.hooks.onToolDenied?.(call);
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content:
            opts.mode === "plan"
              ? "Error: plan mode is active — file changes and command execution are disabled. Explore with the read-only tools and present the implementation plan as plain text; the user approves by switching modes (Shift+Tab)."
              : "Error: permission denied by the user. Do not retry the same action — ask the user or propose an alternative.",
        });
        continue;
      }

      opts.hooks.onToolStart?.(call, summary);
      const ctx: ToolContext = {
        cwd: opts.cwd,
        signal: opts.signal,
        allowOutsideCwd: opts.allowOutsideCwd === true,
        runSubagent: (prompt) => runSubagent(opts, prompt),
      };
      let result: string;
      let isError = false;
      try {
        result = await tool.execute(args, ctx);
      } catch (e) {
        isError = true;
        result = `Error: ${(e as Error).message}`;
      }
      opts.hooks.onToolResult?.(call, result, isError);
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: truncateToolResult(result),
      });
    }
  }

  return { messages, stopReason: "max-iterations", usage };
}

/**
 * Read-only research subagent: own context window, capped iterations, only
 * the parent's read tools (task itself excluded — no recursion). Muted hooks.
 */
async function runSubagent(
  opts: AgentLoopOptions,
  prompt: string,
): Promise<string> {
  const subTools = opts.tools.filter(
    (t) => t.kind === "read" && t.spec.name !== "task",
  );
  const sub = await runAgentLoop({
    provider: opts.provider,
    model: opts.model,
    messages: [
      {
        role: "system",
        content:
          "You are a research subagent of Avery. Explore the project with the read-only tools and answer the task concisely: concrete file paths, symbols, and key findings. You cannot modify files or run commands.",
      },
      { role: "user", content: prompt },
    ],
    tools: subTools,
    cwd: opts.cwd,
    maxIterations: 15,
    allow: [],
    mode: "auto",
    allowOutsideCwd: opts.allowOutsideCwd === true,
    signal: opts.signal,
    hooks: {},
  });
  const last = sub.messages[sub.messages.length - 1];
  return last &&
    last.role === "assistant" &&
    typeof last.content === "string" &&
    last.content.trim().length > 0
    ? last.content
    : "(subagent returned no answer)";
}
