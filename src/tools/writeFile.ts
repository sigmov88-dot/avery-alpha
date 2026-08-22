import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInCwd } from "../util/fsx.ts";
import type { Tool } from "./index.ts";

export const writeFileTool: Tool = {
  kind: "write",
  spec: {
    name: "write_file",
    description:
      "Create a new file or overwrite an existing one with the given content. Parent directories are created automatically. Prefer edit_file for targeted changes to existing files.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path, absolute or relative to the project root",
        },
        content: { type: "string", description: "Full file content" },
      },
      required: ["path", "content"],
    },
  },
  async execute(args, ctx) {
    const p = await resolveInCwd(ctx.cwd, String(args.path ?? ""), {
      allowOutside: ctx.allowOutsideCwd === true,
    });
    const content = String(args.content ?? "");
    const existed = fsSync.existsSync(p);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, "utf8");
    return `${existed ? "Overwrote" : "Created"} ${p} (${content.length} bytes)`;
  },
};
