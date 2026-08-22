import fs from "node:fs/promises";
import path from "node:path";
import { resolveInCwd, SKIP_DIRS } from "../util/fsx.ts";
import type { Tool } from "./index.ts";

const MAX_ENTRIES = 2000;
const MAX_DEPTH = 8;

export const lsTool: Tool = {
  kind: "read",
  spec: {
    name: "ls",
    description:
      "List directory contents. Directories end with '/'. Use recursive=true for an indented tree (skips node_modules, .git, dist, etc.).",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory to list (default: project root)",
        },
        recursive: {
          type: "boolean",
          description: "Show an indented tree (default false)",
        },
      },
    },
  },
  async execute(args, ctx) {
    const root = await resolveInCwd(ctx.cwd, String(args.path ?? "."), {
      allowOutside: ctx.allowOutsideCwd === true,
    });
    const stat = await fs.stat(root).catch(() => null);
    if (!stat) throw new Error(`Directory not found: ${root}`);
    if (!stat.isDirectory()) throw new Error(`${root} is not a directory`);
    const recursive = args.recursive === true;
    const out: string[] = [];

    async function walk(dir: string, depth: number): Promise<void> {
      if (out.length >= MAX_ENTRIES) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort(
        (a, b) =>
          Number(b.isDirectory()) - Number(a.isDirectory()) ||
          a.name.localeCompare(b.name),
      );
      for (const e of entries) {
        if (out.length >= MAX_ENTRIES) return;
        if (SKIP_DIRS.has(e.name)) continue;
        out.push(`${"  ".repeat(depth)}${e.isDirectory() ? e.name + "/" : e.name}`);
        if (recursive && e.isDirectory() && depth < MAX_DEPTH) {
          await walk(path.join(dir, e.name), depth + 1);
        }
      }
    }

    await walk(root, 0);
    if (out.length === 0) return "(empty directory)";
    const suffix =
      out.length >= MAX_ENTRIES ? `\n(truncated at ${MAX_ENTRIES} entries)` : "";
    return out.join("\n") + suffix;
  },
};
