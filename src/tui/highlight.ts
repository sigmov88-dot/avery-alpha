import { gray, green, magenta, yellow } from "./ansi.ts";

/**
 * Zero-dep syntax highlighting for code fences: a single left-to-right pass
 * with one combined regex (comment | string | word | number). The leftmost
 * match wins, so `//` inside a string is a string, quotes inside a comment
 * are a comment. Colors are no-ops on non-TTY — output stays plain text.
 */

const RX_STRING =
  /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/.source;
const RX_NUMBER = /\b\d[\d_]*(?:\.\d+)?\b/.source;
const RX_COMMENT_SLASH = /\/\/.*$/.source;
const RX_COMMENT_HASH = /#.*$/.source;

const KW_C_LIKE = new Set(
  "const let var function return if else for while do import export from default class extends new await async try catch finally throw switch case break continue typeof instanceof this super null undefined true false of in as satisfies keyof readonly static get set public private protected type interface enum implements namespace declare abstract never void string number boolean unknown any bigint symbol object".split(
    " ",
  ),
);
const KW_PY = new Set(
  "def return if elif else for while import from as class try except finally raise with lambda pass yield global nonlocal None True False and or not in is assert del print async await match case".split(
    " ",
  ),
);
const KW_SH = new Set(
  "if then elif else fi for while do done case esac function echo cd export local readonly return exit source alias eval exec shift set unset in".split(
    " ",
  ),
);

function isHashCommentLang(lang: string): boolean {
  return ["py", "python", "sh", "bash", "zsh", "yaml", "yml", "toml", "rb", "ruby"].includes(lang);
}

function keywordsFor(lang: string): Set<string> {
  if (lang === "py" || lang === "python") return KW_PY;
  if (lang === "sh" || lang === "bash" || lang === "zsh") return KW_SH;
  return KW_C_LIKE;
}

/** Highlight one JSON line: keys magenta, strings green, numbers/bools accented. */
function highlightJson(line: string): string {
  const rx = new RegExp(
    `(${/"(?:[^"\\]|\\.)*"/.source})(\\s*:)?|(${RX_NUMBER})|(\btrue\b|\bfalse\b|\bnull\b)`,
    "g",
  );
  return line.replace(rx, (m, ...rest) => {
    const [str, colon] = rest as Array<string | undefined>;
    if (str !== undefined) return colon !== undefined ? magenta(str) + colon : green(str);
    return /\d/.test(m) ? yellow(m) : magenta(m);
  });
}

/** Highlight one code line by fence language (ts/js/py/sh/json; fallback: generic). */
export function highlightCode(line: string, lang: string): string {
  const l = lang.toLowerCase();
  if (l === "json") return highlightJson(line);
  const comment = isHashCommentLang(l) ? RX_COMMENT_HASH : RX_COMMENT_SLASH;
  const kws = keywordsFor(l);
  const rx = new RegExp(
    `(${comment})|(${RX_STRING})|\\b(\\w+)\\b|(${RX_NUMBER})`,
    "g",
  );
  return line.replace(rx, (m, ...rest) => {
    const [cmt, str, word] = rest as Array<string | undefined>;
    if (cmt !== undefined) return gray(m);
    if (str !== undefined) return green(m);
    if (word !== undefined) return kws.has(word) ? magenta(m) : m;
    return yellow(m);
  });
}
