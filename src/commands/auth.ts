import readline from "node:readline";
import {
  DEFAULT_MODEL,
  configPath,
  loadConfig,
  resolveApiKey,
  saveConfig,
} from "../config/index.ts";
import { ProviderError } from "../provider/types.ts";
import { ZenProvider } from "../provider/zen.ts";
import { dim, green, red } from "../tui/ansi.ts";

export async function authLogin(opts: { key?: string }): Promise<number> {
  const config = loadConfig();
  let key = opts.key ?? process.env.OPENCODE_API_KEY ?? "";
  if (key.length === 0) {
    key = await promptSecret("OpenCode ZEN API key (https://opencode.ai): ");
  }
  if (key.length === 0) {
    process.stderr.write(red("no API key provided\n"));
    return 1;
  }

  process.stdout.write(dim("проверяю ключ…\n"));
  try {
    const provider = new ZenProvider({ apiKey: key, baseUrl: config.baseUrl });
    const models = await provider.listModels();
    config.apiKey = key;
    saveConfig(config);
    process.stdout.write(green(`✓ ключ сохранён в ${configPath()}\n`));
    process.stdout.write(
      dim(
        `доступно моделей: ${models.length} · модель по умолчанию: ${config.model ?? DEFAULT_MODEL} (сменить: /model или avery config set model <id>)\n`,
      ),
    );
    return 0;
  } catch (e) {
    const err = e as Error;
    process.stderr.write(red(`ошибка входа: ${err.message}\n`));
    if (err instanceof ProviderError && err.hint) {
      process.stderr.write(dim(err.hint + "\n"));
    }
    return 1;
  }
}

export async function authStatus(): Promise<number> {
  const config = loadConfig();
  const key = resolveApiKey(config);
  if (!key) {
    process.stdout.write(
      "ключ не настроен — выполните `avery auth login` или задайте OPENCODE_API_KEY\n",
    );
    return 1;
  }
  const source =
    process.env.OPENCODE_API_KEY !== undefined
      ? "env OPENCODE_API_KEY"
      : process.env.OPENCODE_ZEN_API_KEY !== undefined
        ? "env OPENCODE_ZEN_API_KEY"
        : configPath();
  try {
    const provider = new ZenProvider({ apiKey: key, baseUrl: config.baseUrl });
    const models = await provider.listModels();
    process.stdout.write(
      green("✓ ключ валиден") +
        dim(` · источник: ${source} · ключ: •••••• · моделей: ${models.length}\n`),
    );
    return 0;
  } catch (e) {
    const err = e as Error;
    process.stderr.write(
      red(`✗ ключ недействителен (${source}): ${err.message}\n`),
    );
    return 1;
  }
}

export function authLogout(): number {
  const config = loadConfig();
  if (config.apiKey === undefined) {
    process.stdout.write(dim("сохранённого ключа нет\n"));
    return 0;
  }
  delete config.apiKey;
  saveConfig(config);
  process.stdout.write(green("✓ ключ удалён из конфига\n"));
  return 0;
}

/** Read a secret without echoing (TTY) or from piped stdin. */
function promptSecret(query: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      let data = "";
      process.stdout.write(query);
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => (data += chunk));
      process.stdin.on("end", () => resolve(data.trim()));
    });
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    const anyRl = rl as unknown as {
      _writeToOutput: (s: string) => void;
      output: NodeJS.WritableStream;
    };
    const original = anyRl._writeToOutput.bind(rl);
    anyRl._writeToOutput = (s: string) => {
      if (s.includes(query) || s === "\n" || s === "\r\n") original(s);
      else anyRl.output.write("*");
    };
    rl.question(query, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}
