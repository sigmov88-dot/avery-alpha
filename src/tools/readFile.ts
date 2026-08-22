import fs from "node:fs/promises";
import path from "node:path";
import { resolveInCwd } from "../util/fsx.ts";
import type { Tool } from "./index.ts";

const MAX_LINES = 2000;
const MAX_LINE_LENGTH = 2000;

export const readFileTool: Tool = {
  kind: "read",
  spec: {
    name: "read_file",
    description:
      "Read a text file from the project; returns numbered lines. Use offset/limit to page through large files instead of reading them whole — context is precious. Always read a file before editing it. To find files by name use glob, to search contents use grep, to list a directory use ls.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path, absolute or relative to the project root",
        },
        offset: {
          type: "number",
          description: "1-based line number to start reading from",
        },
        limit: {
          type: "number",
          description: `Maximum lines to return (default and max ${MAX_LINES})`,
        },
      },
      required: ["path"],
    },
  },
  async execute(args, ctx) {
    const p = await resolveInCwd(ctx.cwd, String(args.path ?? ""), {
      allowOutside: ctx.allowOutsideCwd === true,
    });
    const stat = await fs.stat(p).catch(() => null);
    if (!stat) throw new Error(`File not found: ${p}`);
    if (stat.isDirectory()) {
      throw new Error(`${p} is a directory — use the ls tool instead.`);
    }
    const raw = await fs.readFile(p, "utf8");
    const lines = raw.split("\n");
    const offset = Math.max(1, Math.floor(Number(args.offset ?? 1) || 1));
    const limit = Math.min(
      MAX_LINES,
      Math.max(1, Math.floor(Number(args.limit ?? MAX_LINES) || MAX_LINES)),
    );
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const body = slice
      .map((l, i) => {
        const num = String(offset + i).padStart(6, " ");
        const text =
          l.length > MAX_LINE_LENGTH ? l.slice(0, MAX_LINE_LENGTH) + "…" : l;
        return `${num}\t${text}`;
      })
      .join("\n");
    const end = offset - 1 + slice.length;
    const note =
      end < lines.length
        ? `\n(truncated: showing lines ${offset}–${end} of ${lines.length})`
        : "";
    return body + note;
  },
};
