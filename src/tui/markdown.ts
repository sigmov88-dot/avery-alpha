import { bgCode, bold, cyan, dim, gray, italic, rule } from "./ansi.ts";
import { highlightCode } from "./highlight.ts";
import { renderInline } from "./render.ts";

/**
 * Streaming markdown renderer for assistant output. Accepts arbitrary text
 * chunks and returns formatted output for completed lines; the partial tail
 * line is buffered until "\n" arrives (or flush() is called at turn end).
 *
 * Supported subset: # headings, ``` code fences (indented, background,
 * syntax-highlighted by fence language), -/* bullets, 1. numbered lists,
 * > quotes, --- rules, | pipe tables | (aligned columns), plus the inline
 * subset from renderInline (`code`, **bold**, *italic*, ~~strike~~).
 */
export class StreamMarkdown {
  private buffer = "";
  private inCode = false;
  private codeLang = "";
  private tableBuf: string[] = [];

  /** Feed a text chunk; returns newly completed, formatted lines. */
  write(chunk: string): string {
    this.buffer += chunk;
    let out = "";
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      // Pipe-таблицы буферизуем: рендерим блоком, когда таблица кончилась.
      if (!this.inCode && line.trimStart().startsWith("|")) {
        this.tableBuf.push(line);
        continue;
      }
      if (this.tableBuf.length > 0) out += this.renderTable();
      out += this.renderLine(line) + "\n";
    }
    return out;
  }

  /** Render whatever is left in the buffer (end of the text segment). */
  flush(): string {
    let out = "";
    if (this.tableBuf.length > 0) out += this.renderTable();
    if (this.buffer.length === 0) return out;
    const line = this.buffer;
    this.buffer = "";
    return out + this.renderLine(line) + "\n";
  }

  /** Render buffered pipe-table lines as aligned columns (header + separator). */
  private renderTable(): string {
    const rows = this.tableBuf;
    this.tableBuf = [];
    const cells = rows
      .map((r) =>
        r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()),
      )
      .filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c))); // drop |---|
    if (cells.length === 0) return "";
    const cols = Math.max(...cells.map((r) => r.length));
    const widths: number[] = Array.from({ length: cols }, (_, i) =>
      Math.max(3, ...cells.map((r) => (r[i] ?? "").length)),
    );
    const out: string[] = [];
    cells.forEach((row, ri) => {
      const line = row
        .map((c, i) => (c ?? "").padEnd(widths[i] ?? 3))
        .join(dim(" │ "));
      out.push(ri === 0 ? bold(line) : line);
      if (ri === 0) out.push(dim(widths.map((w) => "─".repeat(w)).join("─┼─")));
    });
    return out.join("\n") + "\n";
  }

  private renderLine(line: string): string {
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      if (this.inCode) {
        this.inCode = false;
        this.codeLang = "";
        return dim("```");
      }
      this.inCode = true;
      this.codeLang = (fence[1] ?? "").toLowerCase();
      return dim("```" + (fence[1] ?? ""));
    }
    if (this.inCode) return "  " + bgCode(highlightCode(line, this.codeLang));

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) return bold(cyan(heading[2] ?? ""));

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return rule();

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) return gray("│ ") + italic(renderInline(quote[1] ?? ""));

    const task = line.match(/^(\s*)[-*]\s+\[( |x)\]\s+(.*)$/);
    if (task) {
      const mark = task[2] === "x" ? cyan("☑") : dim("☐");
      return `${task[1]}${mark} ${renderInline(task[3] ?? "")}`;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) return `${bullet[1]}${cyan("•")} ${renderInline(bullet[2] ?? "")}`;

    const numbered = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (numbered) {
      return `${numbered[1]}${cyan((numbered[2] ?? "") + ".")} ${renderInline(numbered[3] ?? "")}`;
    }

    return renderInline(line);
  }
}
