import {
  CONFIG_KEYS,
  configPath,
  loadConfig,
  saveConfig,
  setConfigValue,
} from "../config/index.ts";
import { dim, green, red } from "../tui/ansi.ts";

function mask(value: unknown): string {
  if (typeof value !== "string") return String(value);
  if (value.length <= 4) return "****";
  return "…" + value.slice(-4);
}

function display(key: string, value: unknown): string {
  if (value === undefined) return dim("(не задано)");
  // маскируем всё, что похоже на API-ключ
  if (key.toLowerCase().includes("key")) return mask(value);
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function configGet(key?: string): number {
  const config = loadConfig();
  if (key === undefined) {
    process.stdout.write(dim(`# ${configPath()}\n`));
    for (const k of CONFIG_KEYS) {
      process.stdout.write(`${k} = ${display(k, config[k])}\n`);
    }
    return 0;
  }
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
    process.stderr.write(
      red(`неизвестный ключ "${key}". Доступные: ${CONFIG_KEYS.join(", ")}\n`),
    );
    return 1;
  }
  process.stdout.write(`${display(key, config[key])}\n`);
  return 0;
}

export function configSet(key: string, value: string): number {
  try {
    const next = setConfigValue(loadConfig(), key, value);
    saveConfig(next);
    process.stdout.write(green(`✓ ${key} сохранён\n`));
    return 0;
  } catch (e) {
    process.stderr.write(red(`${(e as Error).message}\n`));
    return 1;
  }
}
