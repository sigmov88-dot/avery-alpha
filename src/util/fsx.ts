import fs from "node:fs/promises";
import path from "node:path";

export const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".cache",
  "coverage",
  "__pycache__",
]);

/** Convert a glob pattern (with *, **, ?) to an anchored RegExp. */
export function globToRegex(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\.^$+{}()|[]".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

export interface WalkOptions {
  maxFiles?: number;
  skip?: ReadonlySet<string>;
}

/** Recursively collect files under root, skipping noise directories. */
export async function walkFiles(
  root: string,
  opts: WalkOptions = {},
): Promise<string[]> {
  const out: string[] = [];
  const max = opts.maxFiles ?? 20_000;
  const skip = opts.skip ?? SKIP_DIRS;

  async function walk(dir: string): Promise<void> {
    if (out.length >= max) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= max) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name)) await walk(full);
      } else if (e.isFile()) {
        out.push(full);
      }
    }
  }

  await walk(root);
  return out;
}

/** Cheap binary sniff: NUL byte within the first chunk. */
export function looksBinary(text: string): boolean {
  return text.slice(0, 1024).includes("\0");
}

/**
 * Resolve p against cwd and require the result to stay inside the project
 * directory. Symlink-aware: resolves via realpath of the nearest existing
 * ancestor, so `link/../../etc` and symlinked dirs cannot escape.
 * opts.allowOutside disables the check (config allowOutsideCwd).
 */
export async function resolveInCwd(
  cwd: string,
  p: string,
  opts: { allowOutside?: boolean } = {},
): Promise<string> {
  const abs = path.resolve(cwd, p);
  if (opts.allowOutside) return abs;
  const root = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  // Цель может не существовать (write_file нового файла) — ищем
  // ближайшего существующего предка и резолвим его realpath.
  let probe = abs;
  let real: string | null = await fs.realpath(probe).catch(() => null);
  while (real === null) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
    real = await fs.realpath(probe).catch(() => null);
  }
  const effective = real
    ? path.join(real, path.relative(probe, abs))
    : abs;
  if (effective !== root && !effective.startsWith(root + path.sep)) {
    throw new Error(
      `Path escapes the project directory: ${abs}. ` +
        `Доступ вне каталога проекта запрещён (снять: avery config set allowOutsideCwd true).`,
    );
  }
  return abs;
}
