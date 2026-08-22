import fs from "node:fs/promises";
import { lineDiff } from "../tui/diff.ts";
import { resolveInCwd } from "../util/fsx.ts";

/** Read no more than this when diffing write_file against a big existing file. */
const MAX_PREVIEW_SOURCE = 200_000;
const NEW_FILE_LINES = 15;

/**
 * Build a visual preview for write_file/edit_file permission requests.
 * Returns undefined for other tools, empty paths, or sandbox-denied paths
 * (the denial itself will surface when the tool runs).
 */
export async function buildEditPreview(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  allowOutsideCwd: boolean,
): Promise<string | undefined> {
  if (toolName !== "write_file" && toolName !== "edit_file") return undefined;
  const p = String(args.path ?? "");
  if (p.length === 0) return undefined;
  let abs: string;
  try {
    abs = await resolveInCwd(cwd, p, { allowOutside: allowOutsideCwd });
  } catch {
    return undefined;
  }
  const current = await fs.readFile(abs, "utf8").catch(() => null);

  if (toolName === "edit_file") {
    const oldStr = String(args.old_string ?? "");
    const newStr = String(args.new_string ?? "");
    return `--- ${p}\n${lineDiff(oldStr, newStr)}`;
  }

  const next = String(args.content ?? "");
  if (current === null) {
    const lines = next.split("\n");
    const shown = lines.slice(0, NEW_FILE_LINES);
    const rest = lines.length - shown.length;
    return (
      `--- ${p} (новый файл)\n` +
      shown.map((l) => `+ ${l}`).join("\n") +
      (rest > 0 ? `\n… (ещё ${rest} строк)` : "")
    );
  }
  const clipped =
    current.length > MAX_PREVIEW_SOURCE
      ? current.slice(0, MAX_PREVIEW_SOURCE)
      : current;
  return `--- ${p}\n${lineDiff(clipped, next)}`;
}
