import fs from "node:fs/promises";
import path from "node:path";
import { resolveInCwd } from "../util/fsx.ts";
import type { Tool } from "./index.ts";

export const editFileTool: Tool = {
  kind: "write",
  spec: {
    name: "edit_file",
    description:
      "Replace an exact string in an existing file. old_string must match exactly one location unless replace_all is true. Include enough surrounding context to make the match unique.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path, absolute or relative to the project root",
        },
        old_string: { type: "string", description: "Exact text to replace" },
        new_string: { type: "string", description: "Replacement text" },
        replace_all: {
          type: "boolean",
          description: "Replace every occurrence (default false)",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  async execute(args, ctx) {
    const p = await resolveInCwd(ctx.cwd, String(args.path ?? ""), {
      allowOutside: ctx.allowOutsideCwd === true,
    });
    const content = await fs.readFile(p, "utf8").catch(() => {
      throw new Error(
        `File not found: ${p}. Use write_file to create new files.`,
      );
    });
    const oldStr = String(args.old_string ?? "");
    const newStr = String(args.new_string ?? "");
    if (oldStr.length === 0) throw new Error("old_string must not be empty");
    if (oldStr === newStr) throw new Error("old_string and new_string are identical");
    const count = content.split(oldStr).length - 1;
    if (count === 0) throw new Error(`old_string not found in ${p}`);
    const replaceAll = args.replace_all === true;
    if (count > 1 && !replaceAll) {
      throw new Error(
        `old_string matches ${count} locations in ${p}. Provide more context or set replace_all=true.`,
      );
    }
    const next = replaceAll
      ? content.split(oldStr).join(newStr)
      : content.replace(oldStr, newStr);
    await fs.writeFile(p, next, "utf8");
    return `Edited ${p}: replaced ${replaceAll ? count : 1} occurrence(s)`;
  },
};
