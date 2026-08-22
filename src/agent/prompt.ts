import fs from "node:fs";
import path from "node:path";

const MAX_PROJECT_FILE = 20_000;

/** Load project instructions from AVERY.md (or AGENTS.md as fallback). */
export function loadProjectInstructions(cwd: string): string | undefined {
  for (const name of ["AVERY.md", "AGENTS.md"]) {
    try {
      const text = fs.readFileSync(path.join(cwd, name), "utf8").trim();
      if (text.length > 0) return text.slice(0, MAX_PROJECT_FILE);
    } catch {
      // not found — try next name
    }
  }
  return undefined;
}

export function buildSystemPrompt(opts: {
  cwd: string;
  model: string;
  /** Names of connected MCP servers, if any. */
  mcpServers?: string[];
}): string {
  const project = loadProjectInstructions(opts.cwd);
  const today = new Date().toISOString().slice(0, 10);
  const parts = [
    `You are Avery, an AI coding agent running in the user's terminal.`,
    ``,
    `Working directory: ${opts.cwd} (all relative tool paths resolve here)`,
    `Today's date: ${today}`,
    ``,
    `# How you work`,
    `- You help with software engineering: reading, writing and editing code, running commands, debugging, refactoring, explaining.`,
    `- Use your tools instead of asking the user to run commands or paste file contents.`,
    `- Before editing a file, read it first. Keep changes minimal and match the existing style.`,
    `- Prefer edit_file for targeted changes; use write_file for new files or full rewrites.`,
    `- After making changes, verify them: run the project's tests, typecheck or build if available.`,
    `- Never run destructive commands (rm -rf, git reset --hard, git push --force, ...) unless the user explicitly asked for that exact action.`,
    `- If a tool call is denied or fails, do not repeat it unchanged — adjust your approach or ask the user.`,
    `- Keep answers concise. When the task is complete, summarize what you changed in a few short bullet points.`,
    ``,
    `# Tools`,
    `- read_file / ls / glob / grep to explore the project.`,
    `- write_file / edit_file to change files (the user may be asked to approve).`,
    `- bash to run commands (the user may be asked to approve).`,
  ];
  if (opts.mcpServers && opts.mcpServers.length > 0) {
    parts.push(
      `- MCP tools named mcp__<server>__<tool> come from the connected MCP servers: ${opts.mcpServers.join(", ")}. Prefer them when they fit the task.`,
    );
  }
  if (project) {
    parts.push(``, `# Project instructions (AVERY.md)`, project);
  }
  return parts.join("\n");
}
