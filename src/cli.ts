#!/usr/bin/env node
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { authLogin, authLogout, authStatus } from "./commands/auth.ts";
import { configGet, configSet } from "./commands/configCmd.ts";
import { mcpCommand } from "./commands/mcp.ts";
import { listModelsCmd } from "./commands/models.ts";
import { providerCommand } from "./commands/providerCmd.ts";
import { runOnce } from "./commands/run.ts";
import {
  DEFAULT_MAX_ITERATIONS,
  VERSION,
  loadConfig,
} from "./config/index.ts";
import { connectMcp, type McpState } from "./mcp/index.ts";
import { resolveProvider } from "./provider/factory.ts";
import {
  createSession,
  latestSession,
  listSessions,
  loadSession,
  type Session,
} from "./session/index.ts";
import { defaultTools, type Tool } from "./tools/index.ts";
import { cyan, dim, red, yellow } from "./tui/ansi.ts";
import { startTui } from "./tui/app.ts";

const HELP = `⚡ Avery ${VERSION} — AI coding agent (ZEN · Anthropic · OpenAI · Gemini · Ollama · MCP)

Использование:
  avery [опции]                Интерактивный TUI
  avery run "промпт" [опции]   One-shot режим (или: echo "промпт" | avery)
  avery auth login [--key K]   Сохранить API-ключ OpenCode ZEN
  avery auth status            Проверить ключ ZEN
  avery auth logout            Удалить сохранённый ключ
  avery models                 Полный список моделей провайдера
  avery mcp add|list|remove|test   MCP-серверы (как в Claude Code)
  avery provider add|list|remove   Кастомные OpenAI-совместимые провайдеры
  avery config get [ключ]      Показать конфигурацию
  avery config set <к> <з>     Ключи: model, provider, allow, apiKey,
                               anthropicApiKey, openaiApiKey, geminiApiKey, …
  avery --help                 Эта справка
  avery --version              Версия

Опции:
      --provider <p>   Провайдер: zen (по умолчанию), anthropic, openai,
                       gemini, ollama или имя кастомного провайдера
  -m, --model <id>     Модель (для ollama — имя локальной модели)
  -c, --continue       Продолжить последнюю сессию в этом каталоге
  -r, --resume         Выбрать сессию из списка
  -y, --yes            Авто-подтверждение разрешений (one-shot)
      --cwd <dir>      Рабочий каталог (по умолчанию: текущий)
      --verbose        Подробный вывод инструментов в one-shot
  -q, --quiet          TUI без анимированного баннера

Окружение:
  OPENCODE_API_KEY   API-ключ OpenCode ZEN (перекрывает сохранённый)
  ANTHROPIC_API_KEY  API-ключ Anthropic (Claude)
  OPENAI_API_KEY     API-ключ OpenAI
  GEMINI_API_KEY     API-ключ Google Gemini (или GOOGLE_API_KEY)
  OLLAMA_HOST        Адрес Ollama (по умолчанию http://127.0.0.1:11434)
`;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.trim()));
  });
}

function printResolveError(res: { message: string; hint?: string }): void {
  process.stderr.write(red(res.message + "\n"));
  if (res.hint) process.stderr.write(dim(res.hint + "\n"));
}

/** Имена успешно подключённых MCP-серверов (для системного промпта). */
function mcpServerNames(mcp: McpState): string[] {
  return mcp.statuses.filter((s) => s.ok).map((s) => s.name);
}

/**
 * Connect configured MCP servers, warn about failures (never block the
 * session), merge their tools, and always close connections afterwards.
 */
async function withMcp(
  cwd: string,
  fn: (tools: Tool[], mcp: McpState) => Promise<number>,
): Promise<number> {
  const mcp = await connectMcp(cwd);
  for (const s of mcp.statuses) {
    if (!s.ok) {
      process.stderr.write(yellow(`mcp: ${s.name} — ${s.error}\n`));
    }
  }
  try {
    return await fn([...defaultTools(), ...mcp.tools], mcp);
  } finally {
    await mcp.close();
  }
}

async function resolveSession(
  values: { continue?: boolean; resume?: boolean },
  cwd: string,
  model: string,
  providerKind: string,
): Promise<Session> {
  if (values.resume) {
    const sessions = listSessions(cwd).slice(0, 15);
    if (sessions.length === 0) {
      process.stderr.write(dim("(прошлых сессий нет — начинаю новую)\n"));
      return createSession(cwd, model, providerKind);
    }
    sessions.forEach((s, i) => {
      const tag = s.provider ? dim(` · ${s.provider}`) : "";
      process.stdout.write(
        `  ${dim(String(i + 1).padStart(2))}. ${s.title ?? "(без названия)"} ${dim(`· ${s.updatedAt.slice(0, 16).replace("T", " ")} · сообщений: ${s.messages.length}`)}${tag}\n`,
      );
    });
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const pick = await new Promise<string>((resolve) =>
      rl.question(cyan("номер сессии (пусто — новая): "), (a) => {
        rl.close();
        resolve(a);
      }),
    );
    const n = Number.parseInt(pick.trim(), 10);
    if (Number.isFinite(n) && sessions[n - 1]) {
      const loaded = loadSession(sessions[n - 1]!.id);
      if (loaded) return loaded;
    }
    return createSession(cwd, model, providerKind);
  }
  if (values.continue) {
    const latest = latestSession(cwd);
    if (latest) return latest;
    process.stderr.write(dim("(прошлой сессии нет — начинаю новую)\n"));
  }
  return createSession(cwd, model, providerKind);
}

/** Вынимает --cwd <dir> из сырых аргументов подкоманды. */
function extractCwd(args: string[]): { args: string[]; cwd: string } {
  const idx = args.indexOf("--cwd");
  if (idx === -1 || idx + 1 >= args.length) {
    return { args, cwd: path.resolve(process.cwd()) };
  }
  const dir = args[idx + 1]!;
  const rest = [...args.slice(0, idx), ...args.slice(idx + 2)];
  return { args: rest, cwd: path.resolve(dir) };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  // У mcp/provider свои флаги (--url, --env, --header, --scope, ...) —
  // передаём аргументы сырьём, чтобы глобальный parseArgs их не отклонял.
  if (argv[0] === "mcp") {
    const { args, cwd } = extractCwd(argv.slice(1));
    return mcpCommand(args, cwd);
  }
  if (argv[0] === "provider") {
    return providerCommand(argv.slice(1));
  }

  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      provider: { type: "string" },
      model: { type: "string", short: "m" },
      continue: { type: "boolean", short: "c" },
      resume: { type: "boolean", short: "r" },
      yes: { type: "boolean", short: "y" },
      cwd: { type: "string" },
      verbose: { type: "boolean" },
      quiet: { type: "boolean", short: "q" },
      key: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (values.version) {
    process.stdout.write(VERSION + "\n");
    return 0;
  }

  const [cmd, sub, ...rest] = positionals;
  const cwd = path.resolve(values.cwd ?? process.cwd());
  const config = loadConfig();
  const maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  if (values.help || cmd === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  switch (cmd) {
    case "auth": {
      if (sub === "login") return authLogin({ key: values.key });
      if (sub === "status") return authStatus();
      if (sub === "logout") return authLogout();
      process.stderr.write(red("использование: avery auth login|status|logout\n"));
      return 1;
    }

    case "models": {
      const res = await resolveProvider({
        config,
        providerFlag: values.provider,
        modelFlag: values.model,
        allowNoModel: true,
      });
      if (!res.ok) {
        printResolveError(res);
        return 1;
      }
      return listModelsCmd(res.provider, res.model, res.kind);
    }

    case "config": {
      if (sub === "get") return configGet(rest[0]);
      if (sub === "set") {
        const [k, v] = rest;
        if (!k || v === undefined) {
          process.stderr.write(red("использование: avery config set <ключ> <значение>\n"));
          return 1;
        }
        return configSet(k, v);
      }
      process.stderr.write(
        red("использование: avery config get [ключ] | avery config set <ключ> <значение>\n"),
      );
      return 1;
    }

    case "run": {
      let prompt = [sub, ...rest].filter(Boolean).join(" ");
      if (prompt.length === 0 && !process.stdin.isTTY) {
        prompt = await readStdin();
      }
      if (prompt.length === 0) {
        process.stderr.write(red('использование: avery run "промпт"\n'));
        return 1;
      }
      const res = await resolveProvider({
        config,
        providerFlag: values.provider,
        modelFlag: values.model,
      });
      if (!res.ok) {
        printResolveError(res);
        return 1;
      }
      return withMcp(cwd, (tools, mcp) =>
        runOnce({
          prompt,
          provider: res.provider,
          providerKind: res.kind,
          model: res.model,
          cwd,
          config,
          tools,
          maxIterations,
          yes: values.yes === true,
          verbose: values.verbose === true,
          continueSession: values["continue"] === true,
          mcpServers: mcpServerNames(mcp),
        }),
      );
    }

    case undefined: {
      // piped stdin → one-shot
      if (!process.stdin.isTTY) {
        const prompt = await readStdin();
        if (prompt.length === 0) {
          process.stderr.write(red("пустой промпт на stdin\n"));
          return 1;
        }
        const res = await resolveProvider({
          config,
          providerFlag: values.provider,
          modelFlag: values.model,
        });
        if (!res.ok) {
          printResolveError(res);
          return 1;
        }
        return withMcp(cwd, (tools, mcp) =>
          runOnce({
            prompt,
            provider: res.provider,
            providerKind: res.kind,
            model: res.model,
            cwd,
            config,
            tools,
            maxIterations,
            yes: values.yes === true,
            verbose: values.verbose === true,
            continueSession: false,
            mcpServers: mcpServerNames(mcp),
          }),
        );
      }

      // TUI: сначала черновое разрешение (для дефолтов новой сессии)
      const pre = await resolveProvider({
        config,
        providerFlag: values.provider,
        modelFlag: values.model,
        allowNoModel: true,
      });
      if (!pre.ok) {
        printResolveError(pre);
        return 1;
      }
      const session = await resolveSession(
        values,
        cwd,
        values.model ?? pre.model,
        pre.kind,
      );
      // финальное разрешение: продолженная сессия восстанавливает своего
      // провайдера/модель, если их не переопределили флагами
      const res = await resolveProvider({
        config,
        providerFlag: values.provider ?? session.provider,
        modelFlag:
          values.model ??
          (session.messages.length > 0 ? session.model : undefined),
        allowNoModel: true,
      });
      if (!res.ok) {
        printResolveError(res);
        return 1;
      }
      session.provider = res.kind;
      if (res.model) session.model = res.model;
      return withMcp(cwd, async (tools, mcp) => {
        await startTui({
          provider: res.provider,
          providerKind: res.kind,
          cwd,
          session,
          config,
          tools,
          maxIterations,
          mcp,
          quiet: values.quiet === true,
        });
        return 0;
      });
    }

    default:
      process.stderr.write(yellow(`неизвестная команда: ${cmd}\n\n`) + HELP);
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(red(`fatal: ${(err as Error).message}\n`));
    process.exitCode = 1;
  });
