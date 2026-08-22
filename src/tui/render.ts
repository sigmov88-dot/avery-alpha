import { bold, cyan, italic, strike } from "./ansi.ts";

const PLACEHOLDER = "\u0000";

/**
 * Render a small markdown subset for static terminal text:
 * `code`, **bold**, *italic*, ~~strike~~.
 */
export function renderInline(text: string): string {
  const codes: string[] = [];
  let out = text.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(c);
    return `${PLACEHOLDER}${codes.length - 1}${PLACEHOLDER}`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, b: string) => bold(b));
  out = out.replace(/\*([^*\n]+)\*/g, (_m, i: string) => italic(i));
  out = out.replace(/~~([^~]+)~~/g, (_m, s: string) => strike(s));
  out = out.replace(
    new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, "g"),
    (_m, i: string) => cyan(codes[Number(i)] ?? ""),
  );
  return out;
}

/** First non-empty line of a string, truncated for one-line display. */
export function firstLine(s: string, max = 120): string {
  const line = s.split("\n").find((l) => l.trim().length > 0) ?? "";
  const trimmed = line.trim();
  return trimmed.length > max ? trimmed.slice(0, max) + "…" : trimmed;
}
