import { DEFAULT_OPENAI_BASE_URL } from "../config/index.ts";
import { parseSSE } from "./sse.ts";
import type {
  ChatMessage,
  ChatRequest,
  ChatStreamHandlers,
  ModelInfo,
  Provider,
} from "./types.ts";
import { ProviderError } from "./types.ts";

interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: OpenAIToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
  };
}

export interface OpenAIProviderOptions {
  /** API key. Optional: some OpenAI-compatible servers (LM Studio, llama.cpp) need none. */
  apiKey?: string;
  baseUrl?: string;
  /** Provider.name value, e.g. "openai" or "custom:myserver". */
  name?: string;
  /** Human-readable label used in error messages. */
  label?: string;
  /** Extra HTTP headers sent with every request. */
  headers?: Record<string, string>;
  /** Per-status error hints, merged over the defaults. */
  hints?: Record<number, string>;
}

/**
 * Generic OpenAI-compatible provider (chat completions + models, SSE
 * streaming). Used directly for OpenAI and custom providers, and as the
 * base class for OpenCode ZEN.
 */
export class OpenAIProvider implements Provider {
  readonly name: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly label: string;
  private readonly extraHeaders: Record<string, string> | undefined;
  private readonly hints: Record<number, string>;

  constructor(opts: OpenAIProviderOptions = {}) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
    this.name = opts.name ?? "openai";
    this.label = opts.label ?? "OpenAI";
    this.extraHeaders = opts.headers;
    this.hints = {
      401: "Invalid or missing API key. Check your provider credentials.",
      404: "Unknown model or endpoint. Check `avery models` and your baseUrl.",
      429: "Rate limited — retry in a few seconds.",
      ...(opts.hints ?? {}),
    };
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      ...(this.extraHeaders ?? {}),
      ...extra,
    };
  }

  async listModels(opts: { signal?: AbortSignal } = {}): Promise<ModelInfo[]> {
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: this.headers(),
      signal: opts.signal ?? null,
    });
    if (!res.ok) throw await this.toProviderError(res);
    const json = (await res.json()) as {
      data?: Array<{
        id?: string;
        name?: string;
        context_length?: number;
        top_provider?: { context_length?: number };
      }>;
    };
    const items = Array.isArray(json.data) ? json.data : [];
    return items
      .filter((m) => typeof m.id === "string")
      .map((m) => ({
        id: m.id as string,
        name: m.name,
        contextWindow: m.context_length ?? m.top_provider?.context_length,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async streamChat(
    request: ChatRequest,
    handlers: ChatStreamHandlers,
  ): Promise<{ finishReason: string }> {
    const makeBody = (withUsage: boolean) =>
      JSON.stringify({
        model: request.model,
        stream: true,
        ...(withUsage ? { stream_options: { include_usage: true } } : {}),
        messages: request.messages.map(toOpenAIMessage),
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
              tool_choice: "auto",
            }
          : {}),
        ...(request.temperature !== undefined
          ? { temperature: request.temperature }
          : {}),
      });
    const post = (body: string) =>
      fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers({
          "content-type": "application/json",
          accept: "text/event-stream",
        }),
        body,
        signal: request.signal ?? null,
      });
    let res = await post(makeBody(true));
    // Старые OpenAI-совместимые серверы (vLLM, llama.cpp) не знают
    // stream_options и отвечают 400 — повторяем запрос без него.
    if (!res.ok && res.status === 400) {
      const detail = await res.clone().text().catch(() => "");
      if (/stream_options|include_usage/i.test(detail)) {
        res = await post(makeBody(false));
      }
    }
    if (!res.ok || !res.body) throw await this.toProviderError(res);

    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finishReason = "stop";

    for await (const data of parseSSE(res.body)) {
      if (data === "[DONE]") break;
      let chunk: OpenAIChunk;
      try {
        chunk = JSON.parse(data) as OpenAIChunk;
      } catch {
        continue; // tolerate non-JSON keep-alive lines
      }
      if (chunk.usage) {
        handlers.onUsage?.({
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cost: typeof chunk.usage.cost === "number" ? chunk.usage.cost : undefined,
        });
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        handlers.onText?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const slot = pending.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        pending.set(tc.index, slot);
      }
      if (typeof choice.finish_reason === "string" && choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }

    const ordered = [...pending.entries()].sort(([a], [b]) => a - b);
    for (const [, slot] of ordered) {
      handlers.onToolCall?.({
        id:
          slot.id ||
          `call_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        name: slot.name,
        arguments: slot.args,
      });
    }
    return { finishReason };
  }

  protected async toProviderError(res: Response): Promise<ProviderError> {
    let detail = "";
    try {
      const text = await res.text();
      try {
        const json = JSON.parse(text) as { error?: { message?: string } | string };
        detail =
          typeof json.error === "string"
            ? json.error
            : (json.error?.message ?? text);
      } catch {
        detail = text;
      }
    } catch {
      // body unreadable — keep status-only message
    }
    const message = `${this.label} request failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 500)}` : ""}`;
    return new ProviderError(res.status, message, this.hints[res.status]);
  }
}

export function toOpenAIMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.toolCallId, content: m.content ?? "" };
  }
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: m.content ?? null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.arguments },
      })),
    };
  }
  return { role: m.role, content: m.content ?? "" };
}
