import { globToRegex } from "../util/fsx.ts";
import type { ToolKind } from "../tools/index.ts";

export interface PermissionRequest {
  tool: string;
  kind: ToolKind;
  /** Short human-readable target, e.g. file path or bash command. */
  summary: string;
  /** Visual diff of the pending edit (write_file/edit_file), if built. */
  preview?: string;
}

export type PermissionHandler = (req: PermissionRequest) => Promise<boolean>;

export type PermissionMode =
  | "auto"
  | "ask"
  | "allow-all"
  | "plan"
  | "accept-edits";

export interface PermissionCheckerOptions {
  /** Allowlist rules like "bash:git *", "write:src/**", "execute:*". */
  allow: string[];
  mode: PermissionMode;
  ask?: PermissionHandler;
}

/**
 * Build a permission checker.
 * - read tools never require permission
 * - allow-all: everything is allowed (run --yes)
 * - plan: write/execute denied WITHOUT asking — the agent should research
 *   read-only and present a plan (the denial message is shaped by the loop)
 * - accept-edits: file writes pass silently, execute still asks
 * - allowlist rules match `${tool}:${summary}` (and `${kind}:${summary}`)
 * - auto: deny anything not allowlisted (non-interactive one-shot)
 * - ask: fall back to the interactive handler
 */
export function makePermissionChecker(
  opts: PermissionCheckerOptions,
): PermissionHandler {
  const matchers = opts.allow.map(compileRule);
  return async (req) => {
    if (req.kind === "read") return true;
    if (opts.mode === "allow-all") return true;
    if (opts.mode === "plan") return false;
    // Правило матчится и по точному имени тула (write_file:src/**),
    // и по его категории (write:src/** → write_file, edit_file, mcp-тулы).
    const targets = [`${req.tool}:${req.summary}`];
    if (req.kind !== req.tool) targets.push(`${req.kind}:${req.summary}`);
    if (matchers.some((m) => targets.some((t) => m(t)))) return true;
    if (opts.mode === "accept-edits" && req.kind === "write") return true;
    if (opts.mode === "auto") return false;
    if (!opts.ask) return false;
    return opts.ask(req);
  };
}

/** Compile "tool:pattern" into a predicate over "tool:summary" targets. */
export function compileRule(rule: string): (target: string) => boolean {
  const idx = rule.indexOf(":");
  const tool = idx === -1 ? rule.trim() : rule.slice(0, idx).trim();
  const rest = idx === -1 ? "*" : rule.slice(idx + 1).trim();
  const re = globToRegex(rest.length > 0 ? rest : "*");
  return (target: string) => {
    const tIdx = target.indexOf(":");
    if (tIdx === -1) return false;
    const tTool = target.slice(0, tIdx);
    const tRest = target.slice(tIdx + 1);
    return (tool === "*" || tool === tTool) && re.test(tRest);
  };
}
