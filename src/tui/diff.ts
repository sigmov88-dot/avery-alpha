import { dim, green, red } from "./ansi.ts";

/** Max lines shown per changed block in a preview diff. */
const MAX_BLOCK_LINES = 40;
/** Context lines kept around the changed block. */
const CONTEXT = 2;

/**
 * Minimal line diff for permission previews: the common prefix/suffix stay as
 * dim context, the differing middle is shown as -old/+new. Zero deps.
 */
export function lineDiff(oldText: string, newText: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start++;
  }
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (
    endOld > start &&
    endNew > start &&
    oldLines[endOld - 1] === newLines[endNew - 1]
  ) {
    endOld--;
    endNew--;
  }

  const removed = oldLines.slice(start, endOld);
  const added = newLines.slice(start, endNew);
  if (removed.length === 0 && added.length === 0) {
    return dim("  (без изменений)");
  }

  const out: string[] = [];
  if (start > CONTEXT) out.push(dim("  …"));
  for (const l of oldLines.slice(Math.max(0, start - CONTEXT), start)) {
    out.push(dim(`  ${l}`));
  }
  for (const l of cap(removed)) out.push(red(`- ${l}`));
  for (const l of cap(added)) out.push(green(`+ ${l}`));
  for (const l of oldLines.slice(endOld, endOld + CONTEXT)) {
    out.push(dim(`  ${l}`));
  }
  if (endOld + CONTEXT < oldLines.length) out.push(dim("  …"));
  return out.join("\n");
}

function cap(lines: string[]): string[] {
  if (lines.length <= MAX_BLOCK_LINES) return lines;
  return [
    ...lines.slice(0, MAX_BLOCK_LINES),
    `… (ещё ${lines.length - MAX_BLOCK_LINES} строк)`,
  ];
}
