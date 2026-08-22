import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CustomProviderConfig {
  /** Base URL OpenAI-совместимого API, например http://localhost:1234/v1 */
  baseUrl: string;
  /** API-ключ или "env:VAR_NAME" — прочитать из переменной окружения */
  apiKey?: string;
  /** Модель по умолчанию для этого провайдера */
  model?: string;
  /** Дополнительные HTTP-заголовки */
  headers?: Record<string, string>;
}

export interface AveryConfig {
  /** OpenCode ZEN — провайдер по умолчанию */
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** "zen" | "anthropic" | "openai" | "gemini" | "ollama" | "custom:<name>" */
  provider?: string;
  anthropicApiKey?: string;
  anthropicModel?: string;
  anthropicBaseUrl?: string;
  /** Лимит токенов ответа Anthropic (по умолч. 16384) */
  anthropicMaxTokens?: number;
  openaiApiKey?: string;
  openaiModel?: string;
  openaiBaseUrl?: string;
  geminiApiKey?: string;
  geminiModel?: string;
  geminiBaseUrl?: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  maxIterations?: number;
  /** Permission allowlist rules, e.g. "bash:git *", "write:src/**" */
  allow?: string[];
  /** Разрешить файловым тулам выход за пределы cwd (по умолч. false — песочница) */
  allowOutsideCwd?: boolean;
  /** Кастомные OpenAI-совместимые провайдеры (avery provider add) */
  customProviders?: Record<string, CustomProviderConfig>;
  [key: string]: unknown;
}

export const VERSION = "0.3.1";
export const DEFAULT_MODEL = "big-pickle";
export const DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";
export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_MODEL = "gpt-5";
export const DEFAULT_GEMINI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta";
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-pro";
export const DEFAULT_MAX_ITERATIONS = 40;

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "avery");
}

export function dataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base =
    xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".local", "share");
  return path.join(base, "avery");
}

export function sessionsDir(): string {
  return path.join(dataDir(), "sessions");
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

export function loadConfig(): AveryConfig {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as AveryConfig;
    }
    return {};
  } catch {
    return {};
  }
}

export function saveConfig(config: AveryConfig): void {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
}

/** Env vars win over the stored config (OpenCode ZEN key). */
export function resolveApiKey(config: AveryConfig): string | undefined {
  return (
    process.env.OPENCODE_API_KEY ??
    process.env.OPENCODE_ZEN_API_KEY ??
    config.apiKey
  );
}

export const CONFIG_KEYS = [
  "apiKey",
  "model",
  "baseUrl",
  "maxIterations",
  "allow",
  "provider",
  "anthropicApiKey",
  "anthropicModel",
  "anthropicBaseUrl",
  "anthropicMaxTokens",
  "openaiApiKey",
  "openaiModel",
  "openaiBaseUrl",
  "geminiApiKey",
  "geminiModel",
  "geminiBaseUrl",
  "ollamaBaseUrl",
  "ollamaModel",
  "allowOutsideCwd",
  "customProviders",
] as const;

const STRING_KEYS = [
  "apiKey",
  "model",
  "baseUrl",
  "provider",
  "anthropicApiKey",
  "anthropicModel",
  "anthropicBaseUrl",
  "openaiApiKey",
  "openaiModel",
  "openaiBaseUrl",
  "geminiApiKey",
  "geminiModel",
  "geminiBaseUrl",
  "ollamaBaseUrl",
  "ollamaModel",
];

const INT_KEYS = ["maxIterations", "anthropicMaxTokens"];

export function setConfigValue(
  config: AveryConfig,
  key: string,
  value: string,
): AveryConfig {
  const next: AveryConfig = { ...config };
  if (INT_KEYS.includes(key)) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`${key} must be a positive integer, got "${value}"`);
    }
    if (key === "maxIterations") next.maxIterations = n;
    else next.anthropicMaxTokens = n;
  } else if (key === "allowOutsideCwd") {
    if (value !== "true" && value !== "false") {
      throw new Error(`allowOutsideCwd must be true or false, got "${value}"`);
    }
    next.allowOutsideCwd = value === "true";
  } else if (key === "allow") {
    next.allow = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (key === "customProviders") {
    throw new Error(
      "customProviders управляется командами `avery provider add/remove`",
    );
  } else if (STRING_KEYS.includes(key)) {
    next[key] = value;
  } else {
    throw new Error(
      `Unknown config key "${key}". Known keys: ${CONFIG_KEYS.join(", ")}`,
    );
  }
  return next;
}
