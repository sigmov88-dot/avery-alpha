import type { ToolSpec } from "../provider/types.ts";
import { readFileTool } from "./readFile.ts";
import { writeFileTool } from "./writeFile.ts";
import { editFileTool } from "./editFile.ts";
import { bashTool } from "./bash.ts";
import { lsTool } from "./ls.ts";
import { globTool } from "./glob.ts";
import { grepTool } from "./grep.ts";
import { todoWriteTool } from "./todo.ts";

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  /** Разрешить файловым тулам выход за пределы cwd (config allowOutsideCwd). */
  allowOutsideCwd?: boolean;
}

export type ToolKind = "read" | "write" | "execute";

export interface Tool {
  spec: ToolSpec;
  /** read = safe, no permission needed; write/execute = ask or allowlist. */
  kind: ToolKind;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export function defaultTools(): Tool[] {
  return [
    readFileTool,
    writeFileTool,
    editFileTool,
    bashTool,
    lsTool,
    globTool,
    grepTool,
    todoWriteTool,
  ];
}

export function toSpecs(tools: Tool[]): ToolSpec[] {
  return tools.map((t) => t.spec);
}
