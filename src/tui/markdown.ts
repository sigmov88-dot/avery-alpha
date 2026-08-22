import { bgCode, bold, cyan, dim, gray, italic, rule } from "./ansi.ts";
import { renderInline } from "./render.ts";

/**
 * Streaming markdown renderer for assistant output. Accepts arbitrary text
 * chunks and returns formatted output for completed lines; the partial tail
 * line is buffered until "\n" arrives (or flush() is called at turn end).
 *
 * Supported subset: # headings, ``` code fences (indented + background),
 * -/* bullets, 1. numbered lists, > quotes, --- rules, plus the inline
 * subset from renderInline (`code`, **bold**, *italic*, ~~strike~~).
 */
export class StreamMarkdown {
  private buffer = "";
  private inCode = false;

  /** Feed a text chunk; returns newly completed, formatted lines. */
  write(chunk: string): string {
    this.buffer += chunk;
    let out = "";
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      out += this.renderLine(line) + "\n";
    }
    return out;
  }

  /** Render whatever is left in the buffer (end of the text segment). */
  flush(): string {
    if (this.buffer.length === 0) return "";
    const line = this.buffer;
    this.buffer = "";
    return this.renderLine(line) + "\n";
  }

  private renderLine(line: string): string {
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      if (this.inCode) {
        this.inCode = false;
        return dim("```");
      }
      this.inCode = true;
      return dim("```" + (fence[1] ?? ""));
    }
    if (this.inCode) return "  " + bgCode(line);

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
