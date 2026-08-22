import readline from "node:readline";
import { bold, cyan, dim, green, inverse } from "./ansi.ts";

export interface SelectItem {
  id: string;
  label?: string;
  hint?: string;
}

export interface SelectOptions {
  title: string;
  /** Item id to preselect and mark with ● */
  current?: string;
  pageSize?: number;
  /** Called before/after raw key capture (e.g. reset host readline state). */
  suspend?: () => void;
  resume?: () => void;
}

/** Visible window [start, end) for a cursor in a long list. */
export function computeWindow(
  length: number,
  cursor: number,
  pageSize: number,
): { start: number; end: number } {
  if (length <= pageSize) return { start: 0, end: length };
  const start = Math.min(
    Math.max(0, cursor - Math.floor(pageSize / 2)),
    length - pageSize,
  );
  return { start, end: start + pageSize };
}

/**
 * Interactive arrow-key list selector with type-to-filter.
 * Shows ALL items (scrollable window), ↑/↓ to move, Enter to choose,
 * Esc to cancel, Backspace edits the filter. Returns the item id or null.
 */
export async function selectList(
  items: SelectItem[],
  opts: SelectOptions,
): Promise<string | null> {
  if (!process.stdin.isTTY || items.length === 0) return null;
  const pageSize = Math.max(4, opts.pageSize ?? 12);

  let cursor = Math.max(
    0,
    items.findIndex((i) => i.id === opts.current),
  );
  let filter = "";
  let filtered = items;
  let renderedLines = 0;

  const stdin = process.stdin;
  if (stdin.listenerCount("keypress") === 0) {
    readline.emitKeypressEvents(stdin);
  }
  opts.suspend?.();
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);

  const applyFilter = () => {
    const f = filter.trim().toLowerCase();
    filtered = f
      ? items.filter((i) => (i.label ?? i.id).toLowerCase().includes(f))
      : items;
    if (cursor >= filtered.length) cursor = Math.max(0, filtered.length - 1);
  };

  const render = () => {
    let out = "";
    if (renderedLines > 0) out += `\x1b[${renderedLines}A`;
    out += "\x1b[0J";
    const lines: string[] = [];
    lines.push(
      `${cyan("◆")} ${bold(opts.title)} ${dim(`— ${filtered.length}${filtered.length === items.length ? "" : `/${items.length}`}`)}`,
    );
    lines.push(dim("  фильтр: ") + filter + cyan("▌"));
    const { start, end } = computeWindow(filtered.length, cursor, pageSize);
    if (start > 0) lines.push(dim(`  ↑ ещё ${start}`));
    for (let i = start; i < end; i++) {
      const it = filtered[i]!;
      const active = i === cursor;
      const marker = active ? cyan("❯") : " ";
      const text = it.label ?? it.id;
      const hint = it.hint ? dim(` ${it.hint}`) : "";
      const isCurrent = it.id === opts.current ? green(" ●") : "";
      lines.push(
        ` ${marker} ${active ? inverse(` ${text} `) : text}${hint}${isCurrent}`,
      );
    }
    if (filtered.length === 0) lines.push(dim("  (ничего не найдено)"));
    if (end < filtered.length) {
      lines.push(dim(`  ↓ ещё ${filtered.length - end}`));
    }
    lines.push(dim("  ↑↓ — листать · enter — выбрать · esc — отмена"));
    out += lines.join("\n") + "\n";
    renderedLines = lines.length;
    process.stdout.write(out);
  };

  return await new Promise<string | null>((resolve) => {
    const cleanup = () => {
      stdin.removeListener("keypress", onKey);
      if (renderedLines > 0) {
        process.stdout.write(`\x1b[${renderedLines}A\x1b[0J`);
      }
      stdin.setRawMode(wasRaw ?? false);
      opts.resume?.();
    };

    const onKey = (
      str: string | undefined,
      key: { name?: string; sequence?: string; ctrl?: boolean } = {},
    ) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        resolve(null);
        return;
      }
      switch (key.name) {
        case "up":
          if (filtered.length > 0) {
            cursor = (cursor - 1 + filtered.length) % filtered.length;
            render();
          }
          return;
        case "down":
          if (filtered.length > 0) {
            cursor = (cursor + 1) % filtered.length;
            render();
          }
          return;
        case "return":
        case "enter": {
          const sel = filtered[cursor];
          cleanup();
          resolve(sel ? sel.id : null);
          return;
        }
        case "escape":
          cleanup();
          resolve(null);
          return;
        case "backspace":
          if (filter.length > 0) {
            filter = filter.slice(0, -1);
            cursor = 0;
            applyFilter();
            render();
          }
          return;
        default: {
          const seq = key.sequence ?? str;
          if (
            seq &&
            seq.length === 1 &&
            seq.charCodeAt(0) >= 32 &&
            seq.charCodeAt(0) !== 127
          ) {
            filter += seq;
            cursor = 0;
            applyFilter();
            render();
          }
        }
      }
    };

    stdin.on("keypress", onKey);
    render();
  });
}
