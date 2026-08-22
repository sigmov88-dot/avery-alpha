import path from "node:path";
import { globToRegex, resolveInCwd, walkFiles } from "../util/fsx.ts";
import type { Tool } from "./index.ts";

const MAX_RESULTS = 500;

export const globTool: Tool = {
  kind: "read",
  spec: {
    name: "glob",
    description:
      "Find files by glob pattern, e.g. \"src/**/*.ts\" or \"*.json\". Paths are relative to the search base; node_modules, .git, dist etc. are skipped. Use grep to search file contents and read_file to read a specific file.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern to match" },
        path: {
          type: "string",
          description: "Base directory to search from (default: project root)",
        },
      },
      required: ["pattern"],
    },
  },
  async execute(args, ctx) {
    const pattern = String(args.pattern ?? "");
    if (pattern.length === 0) throw new Error("pattern must not be empty");
    const base = await resolveInCwd(ctx.cwd, String(args.path ?? "."), {
      allowOutside: ctx.allowOutsideCwd === true,
    });
    const re = globToRegex(pattern);
    const files = await walkFiles(base);
    const matches = files
      .map((f) => path.relative(base, f).split(path.sep).join("/"))
      .filter((rel) => re.test(rel))
      .slice(0, MAX_RESULTS);
    if (matches.length === 0) return `(no files match "${pattern}")`;
    const suffix =
      matches.length >= MAX_RESULTS
        ? `\n(truncated at ${MAX_RESULTS} matches)`
        : "";
    return matches.join("\n") + suffix;
  },
};
