const enabled =
  process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

const wrap =
  (open: string, close: string) =>
  (s: string): string =>
    enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export const bold = wrap("1", "22");
export const dim = wrap("2", "22");
export const italic = wrap("3", "23");
export const underline = wrap("4", "24");
export const inverse = wrap("7", "27");
export const red = wrap("31", "39");
export const green = wrap("32", "39");
export const yellow = wrap("33", "39");
export const blue = wrap("34", "39");
export const magenta = wrap("35", "39");
export const cyan = wrap("36", "39");
export const gray = wrap("90", "39");
export const strike = wrap("9", "29");

/** Subtle dark background for code lines, no-op on non-TTY. */
export function bgCode(s: string): string {
  return enabled ? `\x1b[48;5;236m\x1b[37m${s}\x1b[39m\x1b[49m` : s;
}

/** Truecolor foreground, no-op on non-TTY. */
export function fgRgb(r: number, g: number, b: number): (s: string) => string {
  return (s) => (enabled ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m` : s);
}

/** Per-line gradient between two RGB colors. */
export function gradientLines(
  lines: string[],
  from: [number, number, number],
  to: [number, number, number],
): string[] {
  const n = Math.max(1, lines.length - 1);
  return lines.map((line, i) => {
    const t = i / n;
    return fgRgb(
      Math.round(from[0] + (to[0] - from[0]) * t),
      Math.round(from[1] + (to[1] - from[1]) * t),
      Math.round(from[2] + (to[2] - from[2]) * t),
    )(line);
  });
}

/** Thin horizontal separator fitted to the terminal width. */
export function rule(width?: number): string {
  const w = width ?? Math.min(process.stdout.columns || 60, 64);
  return dim("─".repeat(Math.max(10, w)));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
