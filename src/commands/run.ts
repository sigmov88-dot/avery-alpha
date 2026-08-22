import { runAgentLoop } from "../agent/loop.ts";
import { buildSystemPrompt } from "../agent/prompt.ts";
import type { AveryConfig } from "../config/index.ts";
import type { ChatMessage, Provider } from "../provider/types.ts";
import { ProviderError } from "../provider/types.ts";
import {
  createSession,
  latestSession,
  loadSession,
  saveSession,
  type Session,
} from "../session/index.ts";
import type { Tool } from "../tools/index.ts";
import { dim, red, yellow } from "../tui/ansi.ts";
import { firstLine } from "../tui/render.ts";

export interface RunOptions {
  prompt: string;
  provider: Provider;
  providerKind: string;
  model: string;
  cwd: string;
  config: AveryConfig;
  tools: Tool[];
  maxIterations: number;
  yes: boolean;
  verbose: boolean;
  continueSession: boolean;
  sessionId?: string;
  /** Connected MCP server names (for the system prompt). */
  mcpServers?: string[];
}

/**
 * One-shot mode: answer text goes to stdout, tool activity to stderr
 * (with --verbose). Mutating tools require --yes or an allow rule.
 */
export async function runOnce(opts: RunOptions): Promise<number> {
  let session: Session | undefined;
  if (opts.sessionId) session = loadSession(opts.sessionId);
  else if (opts.continueSession) session = latestSession(opts.cwd);

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt({
        cwd: opts.cwd,
        model: opts.model,
        mcpServers: opts.mcpServers,
      }),
    },
    ...(session?.messages ?? []),
    { role: "user", content: opts.prompt },
  ];

  const trace = (s: string) => {
    if (opts.verbose) process.stderr.write(dim(s + "\n"));
  };

  try {
    const result = await runAgentLoop({
      provider: opts.provider,
      model: opts.model,
      messages,
      tools: opts.tools,
      cwd: opts.cwd,
      maxIterations: opts.maxIterations,
      allow: opts.config.allow ?? [],
      allowOutsideCwd: opts.config.allowOutsideCwd === true,
      mode: opts.yes ? "allow-all" : "auto",
      hooks: {
        onText: (t) => process.stdout.write(t),
        onToolStart: (call, summary) => trace(`⚙ ${call.name} ${summary}`),
        onToolResult: (_call, r, isError) =>
          trace(`  ${isError ? "✗" : "✓"} ${firstLine(r)}`),
        onToolDenied: (call) =>
          process.stderr.write(
            yellow(
              `запрещено (неинтерактивный режим): ${call.name} — добавь --yes или правило allow\n`,
            ),
          ),
      },
    });
    process.stdout.write("\n");

    const s = session ?? createSession(opts.cwd, opts.model, opts.providerKind);
    s.model = opts.model;
    s.provider = opts.providerKind;
    s.messages = result.messages.slice(1);
    saveSession(s);

    if (result.stopReason === "max-iterations") {
      process.stderr.write(
        yellow(`(остановлено: достигнут лимит итераций ${opts.maxIterations})\n`),
      );
      return 2;
    }
    return 0;
  } catch (e) {
    const err = e as Error;
    if (err instanceof ProviderError) {
      process.stderr.write(red(`\nошибка: ${err.message}\n`));
      if (err.hint) process.stderr.write(dim(err.hint + "\n"));
    } else {
      process.stderr.write(red(`\nошибка: ${err.message}\n`));
    }
    return 1;
  }
}
