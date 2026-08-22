import type {
  ChatMessage,
  ChatRequest,
  ChatStreamHandlers,
  ModelInfo,
  Provider,
} from "./types.ts";
import { ProviderError } from "./types.ts";

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

interface OllamaChatChunk {
  message?: {
    role?: string;
    content?: string;
    tool_calls?: Array<{
      function?: { name?: string; arguments?: Record<string, unknown> };
    }>;
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Ollama provider — local models via the Ollama HTTP API.
 * Chat streams NDJSON (one JSON object per line), not SSE.
 * No API key required. See https://ollama.com
 */
export class OllamaProvider implements Provider {
  readonly name = "ollama";
  private readonly baseUrl: string;

  constructor(opts: { baseUrl?: string } = {}) {
    this.baseUrl = (
      opts.baseUrl ??
      process.env.OLLAMA_HOST ??
      DEFAULT_OLLAMA_URL
    ).replace(/\/+$/, "");
  }

  async listModels(opts: { signal?: AbortSignal } = {}): Promise<ModelInfo[]> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: opts.signal ?? null,
      });
    } catch (e) {
      throw connError(this.baseUrl, e);
    }
    if (!res.ok) {
      throw new ProviderError(
        res.status,
        `Ollama /api/tags failed (HTTP ${res.status})`,
      );
    }
    const json = (await res.json()) as {
      models?: Array<{
        name?: string;
        size?: number;
        details?: { parameter_size?: string; family?: string };
      }>;
    };
    return (json.models ?? [])
      .filter((m) => typeof m.name === "string")
      .map((m) => ({
        id: m.name as string,
        name: m.details?.parameter_size
          ? `${m.name} (${m.details.parameter_size})`
          : m.name,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async streamChat(
    request: ChatRequest,
    handlers: ChatStreamHandlers,
  ): Promise<{ finishReason: string }> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: request.model,
          stream: true,
          messages: request.messages.map(toOllamaMessage),
          ...(request.tools && request.tools.length > 0
            ? {
                tools: request.tools.map((t) => ({
                  type: "function",
                  function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                  },
                })),
              }
            : {}),
        }),
        signal: request.signal ?? null,
      });
    } catch (e) {
      throw connError(this.baseUrl, e);
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new ProviderError(
        res.status,
        `Ollama /api/chat failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`,
        res.status === 404
          ? `Модель "${request.model}" не найдена. Установи: ollama pull ${request.model}`
          : undefined,
      );
    }

    let finishReason = "stop";
    let toolIndex = 0;
    for await (const raw of parseNdjson(res.body)) {
      const chunk = raw as OllamaChatChunk;
      const content = chunk.message?.content;
      if (typeof content === "string" && content.length > 0) {
        handlers.onText?.(content);
      }
      for (const tc of chunk.message?.tool_calls ?? []) {
        const name = tc.function?.name;
        if (!name) continue;
        handlers.onToolCall?.({
          id: `ollama_${Date.now().toString(36)}_${toolIndex++}`,
          name,
          arguments: JSON.stringify(tc.function?.arguments ?? {}),
        });
      }
      if (chunk.done) {
        if (chunk.done_reason) finishReason = chunk.done_reason;
        handlers.onUsage?.({
          inputTokens: chunk.prompt_eval_count ?? 0,
          outputTokens: chunk.eval_count ?? 0,
        });
      }
    }
    return { finishReason };
  }
}

function toOllamaMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") {
    return { role: "tool", name: m.name, content: m.content ?? "" };
  }
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: m.content ?? "",
      tool_calls: m.toolCalls.map((c) => ({
        function: { name: c.name, arguments: safeParseArgs(c.arguments) },
      })),
    };
  }
  return { role: m.role, content: m.content ?? "" };
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

function connError(baseUrl: string, e: unknown): ProviderError {
  const code = (e as { cause?: { code?: string } })?.cause?.code;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new ProviderError(
      0,
      `Не удалось подключиться к Ollama (${baseUrl})`,
      "Запусти Ollama: `ollama serve` · или задай другой адрес через OLLAMA_HOST / avery config set ollamaBaseUrl",
    );
  }
  return new ProviderError(0, `Ollama request failed: ${(e as Error).message}`);
}

/** Ollama streams newline-delimited JSON (one object per line). */
async function* parseNdjson(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.length > 0) yield JSON.parse(line);
      }
    }
    const tail = buffer.trim();
    if (tail.length > 0) yield JSON.parse(tail);
  } finally {
    reader.releaseLock();
  }
}
