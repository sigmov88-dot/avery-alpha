import fs from "node:fs/promises";
import path from "node:path";
import { globToRegex, looksBinary, resolveInCwd, walkFiles } from "../util/fsx.ts";
import type { Tool } from "./index.ts";

const MAX_MATCHES = 100;
const MAX_FILE_SIZE = 1024 * 1024; // 1 MB
const MAX_LINE = 500;

export const grepTool: Tool = {
  kind: "read",
  spec: {
    name: "grep",
    description:
      "Search file contents with a regular expression. Returns matches as 'file:line: text'. Skips binary files and files over 1 MB.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for" },
        path: {
          type: "string",
          description: "File or directory to search (default: project root)",
        },
        glob: {
          type: "string",
          description: "Only search files matching this glob, e.g. \"*.ts\"",
        },
        ignore_case: {
          type: "boolean",
          description: "Case-insensitive search (default false)",
        },
      },
      required: ["pattern"],
    },
  },
  async execute(args, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(String(args.pattern ?? ""), args.ignore_case === true ? "i" : "");
    } catch (e) {
      throw new Error(`Invalid regex: ${(e as Error).message}`);
    }
    const root = await resolveInCwd(ctx.cwd, String(args.path ?? "."), {
      allowOutside: ctx.allowOutsideCwd === true,
    });
    const filter = args.glob ? globToRegex(String(args.glob)) : null;

    const stat = await fs.stat(root).catch(() => null);
    if (!stat) throw new Error(`Path not found: ${root}`);

    const candidates = stat.isDirectory()
      ? (await walkFiles(root)).filter((f) => {
          if (!filter) return true;
          const rel = path.relative(root, f).split(path.sep).join("/");
          return filter.test(rel) || filter.test(path.basename(f));
        })
      : [root];

    const results: string[] = [];
    for (const file of candidates) {
      if (results.length >= MAX_MATCHES) break;
      const fstat = await fs.stat(file).catch(() => null);
      if (!fstat || fstat.size > MAX_FILE_SIZE) continue;
      const text = await fs.readFile(file, "utf8").catch(() => null);
      if (text === null || looksBinary(text)) continue;
      const rel = path.relative(ctx.cwd, file).split(path.sep).join("/");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= MAX_MATCHES) break;
        const line = lines[i]!;
        if (re.test(line)) {
          const shown = line.length > MAX_LINE ? line.slice(0, MAX_LINE) + "…" : line;
          results.push(`${rel}:${i + 1}: ${shown}`);
        }
      }
    }

    if (results.length === 0) return "(no matches)";
    const suffix =
      results.length >= MAX_MATCHES ? `\n(truncated at ${MAX_MATCHES} matches)` : "";
    return results.join("\n") + suffix;
  },
};
