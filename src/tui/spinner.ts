import { cyan, dim } from "./ansi.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;

/**
 * Animated single-line spinner with elapsed time. No-op on non-TTY.
 * `stop()` erases the line; pass a final line to leave a result behind.
 */
export class Spinner {
  private timer: NodeJS.Timeout | undefined;
  private frame = 0;
  private startedAt = 0;
  private text = "";
  private active = false;

  start(text: string): void {
    if (!process.stdout.isTTY) return;
    this.stop();
    this.text = text;
    this.startedAt = Date.now();
    this.active = true;
    this.render();
    this.timer = setInterval(() => this.render(), FRAME_MS);
    this.timer.unref?.();
  }

  update(text: string): void {
    this.text = text;
    if (this.active) this.render();
  }

  stop(finalLine?: string): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.active && process.stdout.isTTY) {
      process.stdout.write("\r\x1b[2K");
    }
    this.active = false;
    if (finalLine !== undefined) process.stdout.write(finalLine + "\n");
  }

  get isActive(): boolean {
    return this.active;
  }

  private render(): void {
    const frame = FRAMES[this.frame++ % FRAMES.length] ?? "-";
    const secs = Math.floor((Date.now() - this.startedAt) / 1000);
    const elapsed = secs >= 2 ? dim(` ${secs}s`) : "";
    process.stdout.write(`\r\x1b[2K ${cyan(frame)} ${this.text}${elapsed}`);
  }
}
