import { DEFAULT_GEMINI_BASE_URL } from "../config/index.ts";
import { parseSSE } from "./sse.ts";
import type {
  ChatMessage,
  ChatRequest,
  ChatStreamHandlers,
  ModelInfo,
  Provider,
  ToolCall,
} from "./types.ts";
import { ProviderError } from "./types.ts";

interface GeminiPart {
  text?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
}

interface GeminiChunk {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

/**
 * Google Gemini provider — generativelanguage API with SSE streaming
 * (:streamGenerateContent?alt=sse).
 * API key: GEMINI_API_KEY / GOOGLE_API_KEY or `avery config set geminiApiKey`.
 */
export class GeminiProvider implements Provider {
  readonly name = "gemini";
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: { apiKey: string; baseUrl?: string }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, "");
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { "x-goog-api-key": this.apiKey, ...extra };
  }

  async listModels(opts: { signal?: AbortSignal } = {}): Promise<ModelInfo[]> {
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: this.headers(),
      signal: opts.signal ?? null,
    });
    if (!res.ok) throw await this.toProviderError(res);
    const json = (await res.json()) as {
      models?: Array<{
        name?: string;
        displayName?: string;
        inputTokenLimit?: number;
      }>;
    };
    const items = Array.isArray(json.models) ? json.models : [];
    return items
      .filter((m) => typeof m.name === "string")
      .map((m) => ({
        id: (m.name as string).replace(/^models\//, ""),
        name: m.displayName,
        contextWindow: m.inputTokenLimit,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async streamChat(
    request: ChatRequest,
    handlers: ChatStreamHandlers,
  ): Promise<{ finishReason: string }> {
    const system = request.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content ?? "")
      .join("\n\n");
    const contents = toGeminiContents(
      request.messages.filter((m) => m.role !== "system"),
    );

    const url = `${this.baseUrl}/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers({
        "content-type": "application/json",
        accept: "text/event-stream",
      }),
      body: JSON.stringify({
        contents,
        ...(system.length > 0
          ? { systemInstruction: { parts: [{ text: system }] } }
          : {}),
        ...(request.tools && request.tools.length > 0
          ? {
              tools: [
                {
                  functionDeclarations: request.tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                  })),
                },
              ],
            }
          : {}),
      }),
      signal: request.signal ?? null,
    });
    if (!res.ok || !res.body) throw await this.toProviderError(res);

    let finishReason = "STOP";
    let usage:
      | { inputTokens: number; outputTokens: number }
      | undefined;
    // Gemini шлёт functionCall частями по ходу стрима — собираем все
    // и отдаём одним набором в конце, чтобы не плодить дубли вызовов
    // (дубль мутации = повторная запись файла).
    const pendingCalls: ToolCall[] = [];

    for await (const data of parseSSE(res.body)) {
      let chunk: GeminiChunk;
      try {
        chunk = JSON.parse(data) as GeminiChunk;
      } catch {
        continue;
      }
      if (chunk.usageMetadata) {
        usage = {
          inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
          outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
        };
      }
      const candidate = chunk.candidates?.[0];
      if (!candidate) continue;
      for (const part of candidate.content?.parts ?? []) {
        if (typeof part.text === "string" && part.text.length > 0) {
          handlers.onText?.(part.text);
        }
        const fc = part.functionCall;
        if (fc?.name) {
          pendingCalls.push({
            id: `gemini_${Date.now().toString(36)}_${pendingCalls.length}`,
            name: fc.name,
            arguments: JSON.stringify(fc.args ?? {}),
          });
        }
      }
      if (typeof candidate.finishReason === "string" && candidate.finishReason) {
        finishReason = candidate.finishReason;
      }
    }

    for (const call of pendingCalls) handlers.onToolCall?.(call);
    if (usage) handlers.onUsage?.(usage);
    return { finishReason };
  }

  private async toProviderError(res: Response): Promise<ProviderError> {
    let detail = "";
    try {
      const text = await res.text();
      try {
        const json = JSON.parse(text) as { error?: { message?: string } };
        detail = json.error?.message ?? text;
      } catch {
        detail = text;
      }
    } catch {
      // body unreadable
    }
    const hints: Record<number, string> = {
      400: "Check the request — the model id may be wrong (`avery models --provider gemini`).",
      403: "Invalid or missing Gemini API key. Set GEMINI_API_KEY or `avery config set geminiApiKey <key>`.",
      404: "Unknown Gemini model. Check `avery models --provider gemini`.",
      429: "Rate limited by Gemini — retry in a few seconds.",
    };
    const message = `Gemini request failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 500)}` : ""}`;
    return new ProviderError(res.status, message, hints[res.status]);
  }
}

function safeParseArgs(args: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Convert chat history to Gemini contents (user/model roles, parts). */
export function toGeminiContents(
  messages: ChatMessage[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === "tool") {
      out.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: m.name ?? "tool",
              response: { result: m.content ?? "" },
            },
          },
        ],
      });
      continue;
    }
    if (m.role === "assistant") {
      const parts: unknown[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const c of m.toolCalls ?? []) {
        parts.push({
          functionCall: { name: c.name, args: safeParseArgs(c.arguments) },
        });
      }
      out.push({ role: "model", parts: parts.length > 0 ? parts : [{ text: " " }] });
      continue;
    }
    if (m.role === "user") {
      out.push({ role: "user", parts: [{ text: m.content ?? "" }] });
    }
  }
  return out;
}
