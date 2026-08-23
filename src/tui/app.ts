import readline from "node:readline";
import { runAgentLoop } from "../agent/loop.ts";
import type { PermissionRequest } from "../agent/permissions.ts";
import { buildSystemPrompt } from "../agent/prompt.ts";
import {
  loadConfig,
  saveConfig,
  VERSION,
  type AveryConfig,
} from "../config/index.ts";
import type { McpState } from "../mcp/index.ts";
import {
  availableProviders,
  resolveProvider,
} from "../provider/factory.ts";
import {
  ProviderError,
  type ModelInfo,
  type Provider,
} from "../provider/types.ts";
import { saveSession, type Session } from "../session/index.ts";
import type { Tool } from "../tools/index.ts";
import { bold, cyan, dim, green, red, rule, yellow } from "./ansi.ts";
import { printBanner } from "./banner.ts";
import { StreamMarkdown } from "./markdown.ts";
import { firstLine } from "./render.ts";
import { selectList } from "./select.ts";
import { Spinner } from "./spinner.ts";
import { THINK_FRAMES } from "./mascot.ts";

/** Синтетический ход для /init: агент изучает проект и пишет AVERY.md. */
const INIT_PROMPT =
  "Проанализируй этот проект и создай AVERY.md в корне — инструкции для AI-агента. " +
  "Сначала изучи package.json (скрипты, зависимости), README, структуру каталогов (ls, glob) " +
  "и 2-3 ключевых файла. Запиши: назначение и стек проекта, точные команды сборки/тестов/линта, " +
  "структуру каталогов, конвенции кода и правила, которых должен придерживаться агент. " +
  "Сжато и по делу, на русском. Если AVERY.md уже существует — прочитай его и предложи " +
  "точечные обновления через edit_file вместо перезаписи.";

/** Режимы разрешений, переключаемые Shift+Tab (как в Claude Code). */
const MODES = ["ask", "accept-edits", "plan"] as const;
type TuiMode = (typeof MODES)[number];

function normalizeMode(v: unknown): TuiMode {
  return MODES.includes(v as TuiMode) ? (v as TuiMode) : "ask";
}

function modeLabel(mode: TuiMode): string {
  if (mode === "plan") return "plan — только исследование и план";
  if (mode === "accept-edits") return "accept-edits — правки без вопросов";
  return "ask — спрашивать разрешение";
}

function promptFor(mode: TuiMode): string {
  if (mode === "plan") return cyan("plan ❯ ");
  if (mode === "accept-edits") return yellow("accept ❯ ");
  return cyan("❯ ");
}

const SLASH_COMMANDS = [
  "/help",
  "/init",
  "/model",
  "/provider",
  "/mcp",
  "/compact",
  "/clear",
  "/cost",
  "/exit",
  "/quit",
];

export interface TuiOptions {
  provider: Provider;
  providerKind: string;
  cwd: string;
  session: Session;
  config: AveryConfig;
  tools: Tool[];
  maxIterations: number;
  mcp?: McpState;
  /** Без анимированного баннера (флаг --quiet). */
  quiet?: boolean;
}

interface Totals {
  input: number;
  output: number;
  cost: number | undefined;
}

interface SlashCtx {
  rl: readline.Interface;
  o: TuiOptions;
  totals: Totals;
  resumeRl: () => void;
  /** true, пока открыт raw-mode селектор — Ctrl+C там = отмена пикера. */
  picker: { open: boolean };
  /** Очередь синтетических ходов (например, /init). */
  pending: string[];
}

function question(rl: readline.Interface, prompt?: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt ?? cyan("❯ "), resolve));
}

/** Tab-completion for slash commands. */
function completer(line: string): [string[], string] {
  if (!line.startsWith("/")) return [[], line];
  const hits = SLASH_COMMANDS.filter((c) => c.startsWith(line));
  return [hits.length > 0 ? hits : SLASH_COMMANDS, line];
}

export async function startTui(o: TuiOptions): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 200,
    completer,
  });
  const allow: string[] = [...(o.config.allow ?? [])];
  const totals: Totals = { input: 0, output: 0, cost: undefined };
  let controller: AbortController | null = null;
  const picker = { open: false };
  const pendingInputs: string[] = [];
  /** Текущий режим разрешений (Shift+Tab); сохраняется в сессии. */
  const currentMode = (): TuiMode => normalizeMode(o.session.mode);
  const mcpNames = (o.mcp?.statuses ?? []).filter((s) => s.ok).map((s) => s.name);

  /** Аккуратный выход: сохранить сессию и закрыть MCP-серверы. */
  const gracefulExit = async (): Promise<void> => {
    try {
      saveSession(o.session);
    } catch {
      // не мешаем выходу
    }
    try {
      await o.mcp?.close();
    } catch {
      // не мешаем выходу
    }
    process.stdout.write(dim("пока!\n"));
    process.exit(0);
  };

  if (o.quiet) {
    process.stdout.write(
      cyan(bold("⚡ avery")) +
        dim(` ${VERSION} · ${o.providerKind} · ${o.session.model || "— (модель: /model)"}`) +
        "\n\n",
    );
  } else {
    await printBanner({
      provider: o.providerKind,
      model: o.session.model,
      cwd: o.cwd,
    });
    printMcpStatus(o.mcp);
  }

  // Ctrl+C: во время хода — прервать ход (ответ сохранится в истории);
  // в простое — дважды за 1.5с для выхода, с закрытием MCP и сессии.
  let lastSigintAt = 0;
  rl.on("SIGINT", () => {
    if (picker.open) return; // селектор сам обрабатывает Ctrl+C как «отмена»
    if (controller) {
      controller.abort();
      return;
    }
    const now = Date.now();
    if (now - lastSigintAt < 1500) {
      void gracefulExit();
      return;
    }
    lastSigintAt = now;
    process.stdout.write(
      "\n" + dim("Ctrl+C ещё раз — выход (или /exit)") + "\n",
    );
  });

  // Shift+Tab — цикл режимов: ask → accept-edits → plan (как в Claude Code).
  // Применяется со следующего хода: текущий уже запущен со своим режимом.
  process.stdin.on("keypress", (_ch, key) => {
    if (picker.open || !key || key.name !== "backtab") return;
    const next = MODES[(MODES.indexOf(currentMode()) + 1) % MODES.length]!;
    o.session.mode = next;
    saveSession(o.session);
    process.stdout.write(
      "\n" + yellow(`⚡ режим: ${modeLabel(next)}`) + dim("  (Shift+Tab — переключить)") + "\n",
    );
  });

  // After the raw-mode selector, the host readline's line buffer may hold
  // junk from arrow keys — reset it before the next question.
  const resumeRl = () => {
    const r = rl as unknown as { line: string; cursor: number };
    r.line = "";
    r.cursor = 0;
  };

  const ask = (req: PermissionRequest): Promise<boolean> =>
    new Promise((resolve) => {
      process.stdout.write(
        "\n" +
          yellow(bold("⚠ разрешить?")) +
          " " +
          bold(req.tool) +
          " " +
          dim(req.summary) +
          "\n",
      );
      // diff preview правки — перед вопросом, чтобы решение было не вслепую
      if (req.preview) process.stdout.write(req.preview + "\n");
      rl.question("  [y] да / [N] нет (Enter) / [a] всегда: ", (ans) => {
        const a = ans.trim().toLowerCase();
        if (a === "a" || a === "always" || a === "в") {
          const rule = `${req.tool}:${req.summary}`;
          allow.push(rule);
          // «всегда» — постоянное правило, сохраняем в конфиг настоящим
          // именем тула (write_file, а не write).
          try {
            const cfg = loadConfig();
            cfg.allow = [...(cfg.allow ?? []), rule];
            saveConfig(cfg);
            o.config.allow = allow;
            process.stdout.write(
              dim(`  правило "${rule}" сохранено в конфиге\n`),
            );
          } catch {
            // конфиг недоступен — правило проживёт до конца сессии
          }
          resolve(true);
          return;
        }
        // Пустой ответ (Enter) — отказ: разрешение только явным «y».
        resolve(a === "y" || a === "yes" || a === "д");
      });
    });

  for (;;) {
    let input = pendingInputs.shift() ?? (await question(rl, promptFor(currentMode())));
    while (input.endsWith("\\")) {
      input = input.slice(0, -1) + "\n" + (await question(rl, dim("… ")));
    }
    input = input.trim();
    if (input.length === 0) continue;

    if (input.startsWith("/")) {
      const shouldExit = await handleSlash(input, { rl, o, totals, resumeRl, picker, pending: pendingInputs });
      if (shouldExit) break;
      continue;
    }

    if (!o.session.model) {
      process.stdout.write(
        yellow("модель не выбрана — открой /model и выбери (↑↓)\n\n"),
      );
      continue;
    }

    o.session.messages.push({ role: "user", content: input });
    controller = new AbortController();

    const think = new Spinner();
    const toolSpin = new Spinner();
    const md = new StreamMarkdown();
    const turn = { input: 0, output: 0, cost: undefined as number | undefined };
    let needLabel = true;
    let toolT0 = 0;
    const t0 = Date.now();

    /** Flush the markdown buffer mid-turn (before tool spinners). */
    const flushMd = () => {
      const rest = md.flush();
      if (rest.length > 0) process.stdout.write(rest);
    };

    think.start("avery думает…", { frames: THINK_FRAMES });
    try {
      const result = await runAgentLoop({
        provider: o.provider,
        model: o.session.model,
        messages: [
          {
            role: "system",
            content: buildSystemPrompt({
              cwd: o.cwd,
              model: o.session.model,
              mcpServers: mcpNames,
              mode: currentMode(),
            }),
          },
          ...o.session.messages,
        ],
        tools: o.tools,
        cwd: o.cwd,
        maxIterations: o.maxIterations,
        allow,
        allowOutsideCwd: o.config.allowOutsideCwd === true,
        mode: currentMode(),
        ask,
        signal: controller.signal,
        hooks: {
          onText: (t) => {
            think.stop();
            if (needLabel) {
              process.stdout.write("\n" + cyan(bold("⚡ avery")) + "\n\n");
              needLabel = false;
            }
            process.stdout.write(md.write(t));
          },
          onToolStart: (call, summary) => {
            flushMd();
            think.stop();
            if (!needLabel) process.stdout.write("\n");
            needLabel = true;
            toolT0 = Date.now();
            process.stdout.write(
              dim("╭─ ") + yellow(call.name) + (summary ? dim("  " + summary) : "") + "\n",
            );
            toolSpin.start(dim("│ выполняю…"));
          },
          onToolResult: (call, resultText, isError) => {
            const dt = ((Date.now() - toolT0) / 1000).toFixed(1);
            toolSpin.stop(
              `${dim("╰─")} ${isError ? red("✗") : green("✓")} ${bold(call.name)} ${dim(firstLine(resultText))} ${dim(`(${dt}s)`)}`,
            );
            think.start("avery думает…", { frames: THINK_FRAMES });
          },
          onToolDenied: (call) => {
            toolSpin.stop(`${dim("╰─")} ${red("✗")} ${bold(call.name)} ${red("отклонено")}`);
            think.start("avery думает…", { frames: THINK_FRAMES });
          },
          onUsage: (u) => {
            turn.input += u.inputTokens;
            turn.output += u.outputTokens;
            if (u.cost !== undefined) turn.cost = (turn.cost ?? 0) + u.cost;
            totals.input += u.inputTokens;
            totals.output += u.outputTokens;
            if (u.cost !== undefined) totals.cost = (totals.cost ?? 0) + u.cost;
          },
        },
      });

      flushMd();
      think.stop();
      toolSpin.stop();
      o.session.messages = result.messages.slice(1); // drop the system message
      saveSession(o.session);

      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      const parts = [o.session.model, `${turn.input} in`, `${turn.output} out`];
      if (turn.cost !== undefined) parts.push(`$${turn.cost.toFixed(4)}`);
      parts.push(`${secs}s`);
      process.stdout.write("\n\n" + dim("  " + parts.join(" · ")) + "\n" + rule() + "\n\n");

      if (result.stopReason === "max-iterations") {
        process.stdout.write(
          yellow(`(стоп: лимит итераций ${o.maxIterations})\n\n`),
        );
      }
    } catch (e) {
      flushMd();
      think.stop();
      toolSpin.stop();
      const err = e as Error;
      if (controller.signal.aborted || err.name === "AbortError") {
        process.stdout.write(yellow("\n(отменено)\n\n"));
      } else if (err instanceof ProviderError) {
        process.stdout.write(red(`\nошибка: ${err.message}\n`));
        if (err.hint) process.stdout.write(dim(err.hint + "\n"));
        process.stdout.write("\n");
      } else {
        process.stdout.write(red(`\nошибка: ${err.message}\n\n`));
      }
    } finally {
      controller = null;
    }
  }
  rl.close();
  process.stdout.write(dim("пока!\n"));
}

/** One line under the banner: connected MCP servers and failures. */
function printMcpStatus(mcp: McpState | undefined): void {
  if (!mcp || mcp.statuses.length === 0) return;
  const parts: string[] = [];
  for (const s of mcp.statuses) {
    parts.push(
      s.ok
        ? green(s.name) + dim(`·${s.tools}`)
        : red(`${s.name}·ошибка`),
    );
  }
  process.stdout.write("  " + dim("mcp: ") + parts.join(dim(", ")) + "\n\n");
}

/** Returns true when the TUI should exit. */
async function handleSlash(input: string, ctx: SlashCtx): Promise<boolean> {
  const [cmdRaw, ...rest] = input.slice(1).trim().split(/\s+/);
  const cmd = (cmdRaw ?? "").toLowerCase();
  const out = (s: string) => process.stdout.write(s + "\n");

  switch (cmd) {
    case "exit":
    case "quit":
      return true;

    case "help":
      out(
        [
          "",
          bold("Avery — команды"),
          "  /help             эта справка",
          "  /init             агент анализирует проект и пишет AVERY.md",
          "  Shift+Tab         режим разрешений: ask → accept-edits → plan",
          "  /model [id]       все модели провайдера (↑↓ — листать, ввод — фильтр)",
          "  /provider [name]  провайдер: zen · anthropic · openai · gemini · ollama · custom",
          "  /mcp              статус MCP-серверов (avery mcp add — добавить)",
          "  /compact          сжать историю диалога (освободить контекст)",
          "  /clear            очистить историю диалога",
          "  /cost             токены и стоимость сессии",
          "  /exit             выход",
          "",
          dim("Многострочный ввод: завершите строку \\ · Ctrl+C отменяет запрос"),
          dim("Tab — автодополнение слэш-команд"),
          "",
        ].join("\n"),
      );
      return false;

    case "init": {
      ctx.pending.push(INIT_PROMPT);
      out(dim("(запускаю анализ проекта → AVERY.md…)"));
      return false;
    }

    case "clear":
      ctx.o.session.messages = [];
      saveSession(ctx.o.session);
      out(dim("(история очищена)"));
      return false;

    case "cost": {
      const t = ctx.totals;
      const cost = t.cost !== undefined ? ` · $${t.cost.toFixed(4)}` : "";
      out(dim(`токены: ${t.input} in / ${t.output} out${cost}`));
      return false;
    }

    case "compact": {
      const msgs = ctx.o.session.messages;
      if (msgs.length < 4) {
        out(dim("(история короткая — сжимать нечего)"));
        return false;
      }
      if (!ctx.o.session.model) {
        out(yellow("модель не выбрана — /model"));
        return false;
      }
      const spin = new Spinner();
      spin.start("сжимаю историю…");
      try {
        let summary = "";
        await ctx.o.provider.streamChat(
          {
            model: ctx.o.session.model,
            messages: [
              {
                role: "system",
                content:
                  "Summarize this conversation between the user and an AI coding agent. " +
                  "Keep: decisions made, files changed, current task state, important " +
                  "identifiers/code, unresolved issues. Answer in the user's language, " +
                  "compact (max ~300 words), plain text.",
              },
              ...msgs,
              { role: "user", content: "Сожми историю выше по инструкции." },
            ],
          },
          { onText: (t) => (summary += t) },
        );
        spin.stop();
        if (summary.trim().length === 0) {
          out(red("модель вернула пустое summary — история не тронута"));
          return false;
        }
        const kept = msgs.slice(-2);
        ctx.o.session.messages = [
          {
            role: "user",
            content: `[Сжатая история предыдущей части сессии]\n${summary.trim()}`,
          },
          ...kept,
        ];
        saveSession(ctx.o.session);
        out(
          green("✓ история сжата") +
            dim(` · было сообщений: ${msgs.length} · summary: ${summary.trim().length} симв.`),
        );
      } catch (e) {
        spin.stop();
        out(red(`ошибка сжатия: ${(e as Error).message}`));
      }
      return false;
    }

    case "mcp": {
      const mcp = ctx.o.mcp;
      if (!mcp || mcp.statuses.length === 0) {
        out(
          dim(
            "MCP-серверы не настроены. Добавь: avery mcp add <имя> <команда> [аргументы]",
          ),
        );
        return false;
      }
      for (const s of mcp.statuses) {
        if (s.ok) {
          out(
            green(`✓ ${s.name}`) +
              dim(` · инструментов: ${s.tools} · ${s.scope}`),
          );
        } else {
          out(red(`✗ ${s.name}`) + dim(` · ${s.error ?? "ошибка"} · ${s.scope}`));
        }
      }
      return false;
    }

    case "model": {
      const arg = rest.join(" ").trim();
      if (arg.length > 0) {
        ctx.o.session.model = arg;
        saveSession(ctx.o.session);
        out(green(`✓ модель: ${arg}`));
        return false;
      }
      await pickModel(ctx);
      return false;
    }

    case "provider": {
      ctx.picker.open = true;
      let kind = rest.join(" ").trim();
      if (!kind) {
        kind =
          (await selectList(
            availableProviders(ctx.o.config).map((p) => ({
              id: p.id,
              label: p.label,
              hint: p.hint,
            })),
            { title: "провайдер", current: ctx.o.providerKind, resume: ctx.resumeRl },
          ).finally(() => {
            ctx.picker.open = false;
          })) ?? "";
      } else {
        ctx.picker.open = false;
      }
      if (!kind) {
        out(dim("(без изменений)"));
        return false;
      }
      const spin = new Spinner();
      spin.start("подключаюсь…");
      const res = await resolveProvider({
        config: ctx.o.config,
        providerFlag: kind,
        allowNoModel: true,
      });
      spin.stop();
      if (!res.ok) {
        out(red(res.message));
        if (res.hint) out(dim(res.hint));
        return false;
      }
      ctx.o.provider = res.provider;
      ctx.o.providerKind = res.kind;
      ctx.o.session.provider = res.kind;
      ctx.o.session.model = res.model;
      saveSession(ctx.o.session);
      out(
        green(
          `✓ провайдер: ${res.kind}${res.model ? ` · модель: ${res.model}` : ""}`,
        ),
      );
      // Пикер модели — только если модель не определилась сама.
      if (!res.model) await pickModel(ctx);
      return false;
    }

    default:
      out(yellow(`неизвестная команда: /${cmd} — попробуй /help`));
      return false;
  }
}

/** Load the full model list of the active provider and open the selector. */
async function pickModel(ctx: SlashCtx): Promise<void> {
  const out = (s: string) => process.stdout.write(s + "\n");
  const spin = new Spinner();
  spin.start("загружаю модели…");
  let models: ModelInfo[] = [];
  try {
    models = await ctx.o.provider.listModels();
  } catch (e) {
    spin.stop();
    const err = e as Error;
    out(red(`ошибка: ${err.message}`));
    if (err instanceof ProviderError && err.hint) out(dim(err.hint));
    return;
  }
  spin.stop();
  if (models.length === 0) {
    out(
      yellow(
        "модели не найдены" +
          (ctx.o.providerKind === "ollama"
            ? " — установи локальную модель: ollama pull llama3.1"
            : ""),
      ),
    );
    return;
  }
  ctx.picker.open = true;
  const picked = await selectList(
    models.map((m) => ({
      id: m.id,
      label: m.id.length > 48 ? m.id.slice(0, 47) + "…" : m.id,
      hint:
        m.contextWindow !== undefined
          ? `${Math.round(m.contextWindow / 1000)}k ctx`
          : m.name && m.name !== m.id
            ? m.name
            : undefined,
    })),
    {
      title: `модели — ${ctx.o.providerKind}`,
      current: ctx.o.session.model,
      resume: ctx.resumeRl,
    },
  ).finally(() => {
    ctx.picker.open = false;
  });
  if (picked) {
    ctx.o.session.model = picked;
    saveSession(ctx.o.session);
    out(green(`✓ модель: ${picked}`));
  } else {
    out(dim("(без изменений)"));
  }
}
