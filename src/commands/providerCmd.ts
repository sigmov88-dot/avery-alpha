import { loadConfig, saveConfig } from "../config/index.ts";
import { availableProviders } from "../provider/factory.ts";
import { cyan, dim, green, red, yellow } from "../tui/ansi.ts";

const USAGE = `использование:
  avery provider list                              все провайдеры
  avery provider add <имя> --url <baseUrl> [опции] добавить OpenAI-совместимый
     опции: --key <ключ | env:VAR> · --model <id> · --header "K: V"
  avery provider remove <имя>                      удалить кастомный провайдер

Использование: avery --provider <имя> [-m <модель>]
Пример: avery provider add lmstudio --url http://localhost:1234/v1
        avery provider add openrouter --url https://openrouter.ai/api/v1 --key env:OPENROUTER_API_KEY --model gpt-5
`;

export function providerCommand(args: string[]): number {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
    case undefined:
      return listProviders();
    case "add":
      return addProvider(rest);
    case "remove":
    case "rm":
      return removeProvider(rest[0]);
    default:
      process.stderr.write(red(USAGE));
      return 1;
  }
}

function listProviders(): number {
  const config = loadConfig();
  for (const p of availableProviders(config)) {
    const current =
      (config.provider ?? "zen") === p.id || config.provider === p.label;
    process.stdout.write(
      `  ${cyan(p.id)}${current ? green(" ●") : ""}  ${p.label} ${dim(`· ${p.hint}`)}\n`,
    );
  }
  process.stdout.write(dim("\n● — активный · переключить: avery --provider <id>\n"));
  return 0;
}

function addProvider(args: string[]): number {
  const [name, ...rest] = args;
  if (!name) {
    process.stderr.write(red("укажи имя провайдера\n" + USAGE));
    return 1;
  }
  if (name.includes(":") || name.startsWith("-")) {
    process.stderr.write(red("имя не должно содержать ':' или начинаться с '-'\n"));
    return 1;
  }
  let baseUrl: string | undefined;
  let apiKey: string | undefined;
  let model: string | undefined;
  const headers: Record<string, string> = {};

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--url") baseUrl = rest[++i];
    else if (a === "--key") apiKey = rest[++i];
    else if (a === "--model") model = rest[++i];
    else if (a === "--header") {
      const kv = rest[++i] ?? "";
      const colon = kv.indexOf(":");
      if (colon <= 0) {
        process.stderr.write(red(`--header ожидает "Key: Value", получено "${kv}"\n`));
        return 1;
      }
      headers[kv.slice(0, colon).trim()] = kv.slice(colon + 1).trim();
    } else if (!baseUrl && /^https?:\/\//.test(a)) {
      baseUrl = a; // позиционный URL
    } else {
      process.stderr.write(red(`неизвестный аргумент "${a}"\n` + USAGE));
      return 1;
    }
  }

  if (!baseUrl) {
    process.stderr.write(red("обязателен --url <baseUrl>\n" + USAGE));
    return 1;
  }

  const config = loadConfig();
  const customs = { ...(config.customProviders ?? {}) };
  customs[name] = {
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(model ? { model } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
  config.customProviders = customs;
  saveConfig(config);
  process.stdout.write(green(`✓ провайдер "${name}" сохранён\n`));
  process.stdout.write(
    dim(`использование: avery --provider ${name}${model ? "" : " -m <модель>"}\n`),
  );
  return 0;
}

function removeProvider(name: string | undefined): number {
  if (!name) {
    process.stderr.write(red("использование: avery provider remove <имя>\n"));
    return 1;
  }
  const config = loadConfig();
  const customs = { ...(config.customProviders ?? {}) };
  if (!(name in customs)) {
    process.stderr.write(yellow(`кастомный провайдер "${name}" не найден\n`));
    return 1;
  }
  delete customs[name];
  if (Object.keys(customs).length > 0) config.customProviders = customs;
  else delete config.customProviders;
  saveConfig(config);
  process.stdout.write(green(`✓ провайдер "${name}" удалён\n`));
  return 0;
}
