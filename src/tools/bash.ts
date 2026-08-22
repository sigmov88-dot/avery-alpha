import { exec } from "node:child_process";
import type { Tool } from "./index.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT = 100_000;

export const bashTool: Tool = {
  kind: "execute",
  spec: {
    name: "bash",
    description:
      "Run a bash command in the project directory — builds, tests, git, package managers, scripts. Returns stdout and stderr; non-zero exit codes are reported, not thrown. Prefer the dedicated file tools (read_file/write_file/edit_file/glob/grep) over shell equivalents: they are sandboxed and produce cleaner output. Destructive commands (rm -rf, git reset --hard, git push --force) only when the user explicitly asked for that exact action.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command to run" },
        timeout: {
          type: "number",
          description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`,
        },
      },
      required: ["command"],
    },
  },
  async execute(args, ctx) {
    const command = String(args.command ?? "");
    if (command.trim().length === 0) throw new Error("command must not be empty");
    const timeout = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(1000, Math.floor(Number(args.timeout ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS)),
    );
    return await new Promise<string>((resolve, reject) => {
      const child = exec(
        command,
        {
          cwd: ctx.cwd,
          timeout,
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, CI: "true", PAGER: "cat" },
        },
        (err, stdout, stderr) => {
          const out = [stdout, stderr]
            .filter((s) => s && s.length > 0)
            .join("\n")
            .trimEnd();
          if (err && (err as { killed?: boolean }).killed) {
            resolve(truncate(`${out}\n(command timed out after ${timeout}ms)`));
            return;
          }
          const code = (err as { code?: unknown } | null)?.code;
          if (err && typeof code === "number") {
            resolve(truncate(`${out}\n(exit code ${code})`));
            return;
          }
          if (err) {
            reject(err);
            return;
          }
          resolve(out.length > 0 ? truncate(out) : "(no output)");
        },
      );
      ctx.signal?.addEventListener("abort", () => child.kill("SIGTERM"), {
        once: true,
      });
    });
  },
};

function truncate(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= MAX_OUTPUT) return trimmed;
  return (
    trimmed.slice(0, MAX_OUTPUT) +
    `\n(output truncated at ${MAX_OUTPUT} characters)`
  );
}
