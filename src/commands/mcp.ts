import { McpClient } from "../mcp/client.ts";
import {
  loadMcpServers,
  projectMcpPath,
  removeMcpServer,
  saveMcpServer,
  userMcpPath,
  type McpScope,
  type McpServerConfig,
} from "../mcp/config.ts";
import { cyan, dim, green, red, yellow } from "../tui/ansi.ts";

const USAGE = `использование:
  avery mcp list                              список серверов (user + project)
  avery mcp add <имя> <команда> [аргументы]   stdio-сервер
  avery mcp add <имя> --url <https://…>       HTTP-сервер
     опции add: --scope user|project (по умолч. user → ~/.config/avery/mcp.json,
                project → ./.mcp.json) · --env KEY=VAL · --header "K: V"
  avery mcp remove <имя> [--scope project]    удалить сервер
  avery mcp test <имя>                        подключиться и показать инструменты

Пример (как в Claude Code):
  avery mcp add fs npx -y @modelcontextprotocol/server-filesystem .
`;

export async function mcpCommand(args: string[], cwd: string): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
    case undefined:
      return listServers(cwd);
    case "add":
      return addServer(rest, cwd);
    case "remove":
    case "rm":
      return removeServerCmd(rest, cwd);
    case "test":
      return testServer(rest[0], cwd);
    default:
      process.stderr.write(red(USAGE));
      return 1;
  }
}

function listServers(cwd: string): number {
  const servers = loadMcpServers(cwd);
  if (servers.length === 0) {
    process.stdout.write(
      dim("MCP-серверы не настроены.\nДобавь: avery mcp add <имя> <команда>\n"),
    );
    return 0;
  }
  process.stdout.write(
    dim(`# user: ${userMcpPath()} · project: ${projectMcpPath(cwd)}\n`),
  );
  for (const s of servers) {
    const target = s.config.url ?? [s.config.command, ...(s.config.args ?? [])].join(" ");
    process.stdout.write(
      `  ${cyan(s.name)} ${dim(`(${s.scope})`)}  ${target ?? ""}\n`,
    );
  }
  return 0;
}

function addServer(args: string[], cwd: string): number {
  const [name, ...rest] = args;
  if (!name) {
    process.stderr.write(red("укажи имя сервера\n" + USAGE));
    return 1;
  }
  let scope: McpScope = "user";
  let url: string | undefined;
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const cmdParts: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--scope") {
      const v = rest[++i];
      if (v !== "user" && v !== "project") {
        process.stderr.write(red("--scope должен быть user или project\n"));
        return 1;
      }
      scope = v;
    } else if (a === "--url") {
      url = rest[++i];
    } else if (a === "--env") {
      const kv = rest[++i] ?? "";
      const eq = kv.indexOf("=");
      if (eq <= 0) {
        process.stderr.write(red(`--env ожидает KEY=VALUE, получено "${kv}"\n`));
        return 1;
      }
      env[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a === "--header") {
      const kv = rest[++i] ?? "";
      const colon = kv.indexOf(":");
      if (colon <= 0) {
        process.stderr.write(red(`--header ожидает "Key: Value", получено "${kv}"\n`));
        return 1;
      }
      headers[kv.slice(0, colon).trim()] = kv.slice(colon + 1).trim();
    } else {
      cmdParts.push(a);
    }
  }

  // Автоопределение: первый аргумент — http(s) URL → HTTP-транспорт
  if (!url && cmdParts[0] && /^https?:\/\//.test(cmdParts[0])) {
    url = cmdParts.shift();
  }

  let config: McpServerConfig;
  if (url) {
    config = { url };
    if (Object.keys(headers).length > 0) config.headers = headers;
  } else {
    const [command, ...cmdArgs] = cmdParts;
    if (!command) {
      process.stderr.write(red("укажи команду или --url\n" + USAGE));
      return 1;
    }
    config = { command };
    if (cmdArgs.length > 0) config.args = cmdArgs;
    if (Object.keys(env).length > 0) config.env = env;
  }

  saveMcpServer(scope, cwd, name, config);
  const where = scope === "user" ? userMcpPath() : projectMcpPath(cwd);
  process.stdout.write(green(`✓ сервер "${name}" добавлен`) + dim(` → ${where}\n`));
  process.stdout.write(dim("проверить: avery mcp test " + name + "\n"));
  return 0;
}

function removeServerCmd(args: string[], cwd: string): number {
  const name = args[0];
  if (!name) {
    process.stderr.write(red("использование: avery mcp remove <имя> [--scope project]\n"));
    return 1;
  }
  const scopeIdx = args.indexOf("--scope");
  const scope: McpScope =
    scopeIdx !== -1 && args[scopeIdx + 1] === "project" ? "project" : "user";
  if (removeMcpServer(scope, cwd, name)) {
    process.stdout.write(green(`✓ сервер "${name}" удалён (${scope})\n`));
    return 0;
  }
  process.stderr.write(
    yellow(`сервер "${name}" не найден в ${scope === "user" ? userMcpPath() : projectMcpPath(cwd)}\n`),
  );
  return 1;
}

async function testServer(name: string | undefined, cwd: string): Promise<number> {
  if (!name) {
    process.stderr.write(red("использование: avery mcp test <имя>\n"));
    return 1;
  }
  const server = loadMcpServers(cwd).find((s) => s.name === name);
  if (!server) {
    process.stderr.write(red(`сервер "${name}" не найден\n`));
    return 1;
  }
  process.stdout.write(dim(`подключаюсь к "${name}" (${server.scope})…\n`));
  let client: McpClient;
  try {
    client = await McpClient.connect(server.config, { timeoutMs: 15_000 });
  } catch (e) {
    process.stderr.write(red(`✗ не удалось подключиться: ${(e as Error).message}\n`));
    return 1;
  }
  try {
    const tools = await client.listTools();
    process.stdout.write(green(`✓ подключено · инструментов: ${tools.length}\n`));
    for (const t of tools) {
      process.stdout.write(
        `  ${cyan(`mcp__${name}__${t.name}`)} ${dim((t.description ?? "").split("\n")[0]?.slice(0, 72) ?? "")}\n`,
      );
    }
    return 0;
  } finally {
    await client.close();
  }
}
