import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_MODEL,
  DEFAULT_OPENAI_MODEL,
  resolveApiKey,
  type AveryConfig,
  type CustomProviderConfig,
} from "../config/index.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { GeminiProvider } from "./gemini.ts";
import { OllamaProvider } from "./ollama.ts";
import { OpenAIProvider } from "./openai.ts";
import type { Provider } from "./types.ts";
import { ZenProvider } from "./zen.ts";

/** "zen" | "anthropic" | "openai" | "gemini" | "ollama" | "custom:<name>" */
export type ProviderKind = string;

export interface ResolveOptions {
  config: AveryConfig;
  providerFlag?: string;
  modelFlag?: string;
  /** Allow resolving without a model (e.g. `avery models`). */
  allowNoModel?: boolean;
}

export type ResolveResult =
  | { ok: true; provider: Provider; kind: ProviderKind; model: string }
  | { ok: false; message: string; hint?: string };

export interface ProviderListItem {
  id: string;
  label: string;
  hint: string;
}

/** Providers shown in the /provider selector and `avery provider list`. */
export function availableProviders(config: AveryConfig): ProviderListItem[] {
  const customs = Object.entries(config.customProviders ?? {}).map(
    ([name, c]) => ({
      id: `custom:${name}`,
      label: name,
      hint: `custom · ${c.baseUrl}`,
    }),
  );
  return [
    {
      id: "zen",
      label: "OpenCode ZEN",
      hint: "облако · opencode.ai/zen · по умолчанию",
    },
    {
      id: "anthropic",
      label: "Anthropic (Claude)",
      hint: "api.anthropic.com · ANTHROPIC_API_KEY",
    },
    { id: "openai", label: "OpenAI", hint: "api.openai.com · OPENAI_API_KEY" },
    {
      id: "gemini",
      label: "Google Gemini",
      hint: "generativelanguage · GEMINI_API_KEY",
    },
    { id: "ollama", label: "Ollama", hint: "локально · 127.0.0.1:11434" },
    ...customs,
  ];
}

export function normalizeProviderKind(raw: string): ProviderKind | null {
  const v = raw.trim().toLowerCase();
  if (v === "zen" || v === "opencode" || v === "opencode-zen") return "zen";
  if (v === "anthropic" || v === "claude") return "anthropic";
  if (v === "openai" || v === "gpt") return "openai";
  if (v === "gemini" || v === "google") return "gemini";
  if (v === "ollama" || v === "local") return "ollama";
  if (v.startsWith("custom:")) {
    const name = raw.trim().slice("custom:".length).trim();
    return name.length > 0 ? `custom:${name}` : null;
  }
  return null;
}

/** "env:VAR" → значение переменной окружения, иначе строка как есть. */
export function resolveKeyValue(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (raw.startsWith("env:")) {
    return process.env[raw.slice(4)] ?? undefined;
  }
  return raw;
}

/**
 * Resolve the active provider from flags + config.
 * zen (default): needs an API key. anthropic/openai/gemini: env or config key.
 * ollama: no key; model = flag ?? config ?? first installed.
 * custom:<name>: OpenAI-compatible endpoint from config.customProviders.
 */
export async function resolveProvider(
  opts: ResolveOptions,
): Promise<ResolveResult> {
  const raw = opts.providerFlag ?? opts.config.provider ?? "zen";
  const customs = opts.config.customProviders ?? {};
  let kind = normalizeProviderKind(raw);
  if (!kind) {
    const hit = Object.keys(customs).find(
      (n) => n.toLowerCase() === raw.trim().toLowerCase(),
    );
    if (hit) kind = `custom:${hit}`;
  }
  if (!kind) {
    return {
      ok: false,
      message: `Неизвестный провайдер "${raw}"`,
      hint:
        "Доступны: zen, anthropic, openai, gemini, ollama" +
        ", и кастомные: avery provider add <имя> --url <baseUrl>",
    };
  }

  if (kind === "zen") {
    const apiKey = resolveApiKey(opts.config);
    if (!apiKey) {
      return {
        ok: false,
        message: "Нет API-ключа OpenCode ZEN",
        hint: "Выполни `avery auth login` или задай OPENCODE_API_KEY",
      };
    }
    return {
      ok: true,
      provider: new ZenProvider({ apiKey, baseUrl: opts.config.baseUrl }),
      kind,
      model: opts.modelFlag ?? opts.config.model ?? DEFAULT_MODEL,
    };
  }

  if (kind === "anthropic") {
    const apiKey =
      process.env.ANTHROPIC_API_KEY ?? opts.config.anthropicApiKey;
    if (!apiKey) {
      return {
        ok: false,
        message: "Нет API-ключа Anthropic",
        hint: "Задай ANTHROPIC_API_KEY или `avery config set anthropicApiKey <ключ>`",
      };
    }
    return {
      ok: true,
      provider: new AnthropicProvider({
        apiKey,
        baseUrl: opts.config.anthropicBaseUrl,
        maxTokens: opts.config.anthropicMaxTokens,
      }),
      kind,
      model:
        opts.modelFlag ?? opts.config.anthropicModel ?? DEFAULT_ANTHROPIC_MODEL,
    };
  }

  if (kind === "openai") {
    const apiKey = process.env.OPENAI_API_KEY ?? opts.config.openaiApiKey;
    if (!apiKey) {
      return {
        ok: false,
        message: "Нет API-ключа OpenAI",
        hint: "Задай OPENAI_API_KEY или `avery config set openaiApiKey <ключ>`",
      };
    }
    return {
      ok: true,
      provider: new OpenAIProvider({
        apiKey,
        baseUrl: opts.config.openaiBaseUrl,
        name: "openai",
        label: "OpenAI",
        hints: {
          401: "Invalid or missing OpenAI API key. Set OPENAI_API_KEY or `avery config set openaiApiKey <key>`.",
        },
      }),
      kind,
      model: opts.modelFlag ?? opts.config.openaiModel ?? DEFAULT_OPENAI_MODEL,
    };
  }

  if (kind === "gemini") {
    const apiKey =
      process.env.GEMINI_API_KEY ??
      process.env.GOOGLE_API_KEY ??
      opts.config.geminiApiKey;
    if (!apiKey) {
      return {
        ok: false,
        message: "Нет API-ключа Gemini",
        hint: "Задай GEMINI_API_KEY или `avery config set geminiApiKey <ключ>`",
      };
    }
    return {
      ok: true,
      provider: new GeminiProvider({
        apiKey,
        baseUrl: opts.config.geminiBaseUrl,
      }),
      kind,
      model: opts.modelFlag ?? opts.config.geminiModel ?? DEFAULT_GEMINI_MODEL,
    };
  }

  if (kind === "ollama") {
    const provider = new OllamaProvider({ baseUrl: opts.config.ollamaBaseUrl });
    let model = opts.modelFlag ?? opts.config.ollamaModel ?? "";
    if (!model) {
      try {
        model = (await provider.listModels())[0]?.id ?? "";
      } catch {
        model = "";
      }
    }
    if (!model && !opts.allowNoModel) {
      return {
        ok: false,
        message: "Не выбрана модель Ollama (или локально не установлена ни одна)",
        hint: "Установи модель: `ollama pull llama3.1`, затем `avery --provider ollama -m llama3.1`",
      };
    }
    return { ok: true, provider, kind, model };
  }

  // custom:<name>
  const name = kind.slice("custom:".length);
  const cfg: CustomProviderConfig | undefined = customs[name];
  if (!cfg) {
    return {
      ok: false,
      message: `Кастомный провайдер "${name}" не найден`,
      hint: "Добавь: `avery provider add " + name + " --url <baseUrl>`",
    };
  }
  const provider = new OpenAIProvider({
    apiKey: resolveKeyValue(cfg.apiKey),
    baseUrl: cfg.baseUrl,
    name: `custom:${name}`,
    label: name,
    headers: cfg.headers,
  });
  let model = opts.modelFlag ?? cfg.model ?? "";
  if (!model) {
    try {
      model = (await provider.listModels())[0]?.id ?? "";
    } catch {
      model = "";
    }
  }
  if (!model && !opts.allowNoModel) {
    return {
      ok: false,
      message: `Не выбрана модель для "${name}"`,
      hint: `Задай: \`avery provider add ${name} --url ${cfg.baseUrl} --model <id>\` или флаг -m`,
    };
  }
  return { ok: true, provider, kind, model };
}
