import { DEFAULT_ANTHROPIC_BASE_URL } from "../config/index.ts";
import { parseSSE } from "./sse.ts";
import type {
  ChatMessage,
  ChatRequest,
  ChatStreamHandlers,
  ModelInfo,
  Provider,
  ToolSpec,
} from "./types.ts";
import { ProviderError } from "./types.ts";

const API_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 16384;

interface AnthropicEvent {
  type: string;
  index?: number;
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  content_block?: {
    type: string;
    id?: string;
    name?: string;
  };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: { output_tokens?: number };
  error?: { type?: string; message?: string };
}

/**
 * Anthropic provider — Claude models via the Messages API
 * (https://api.anthropic.com/v1/messages, SSE streaming).
 * API key: ANTHROPIC_API_KEY or `avery config set anthropicApiKey`.
 */
export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;

  constructor(opts: { apiKey: string; baseUrl?: string; maxTokens?: number }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, "");
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      "x-api-key": this.apiKey,
      "anthropic-version": API_VERSION,
      ...extra,
    };
  }

  async listModels(opts: { signal?: AbortSignal } = {}): Promise<ModelInfo[]> {
    const res = await fetch(`${this.baseUrl}/v1/models`, {
      headers: this.headers(),
      signal: opts.signal ?? null,
    });
    if (!res.ok) throw await this.toProviderError(res);
    const json = (await res.json()) as {
      data?: Array<{ id?: string; display_name?: string }>;
    };
    const items = Array.isArray(json.data) ? json.data : [];
    return items
      .filter((m) => typeof m.id === "string")
      .map((m) => ({ id: m.id as string, name: m.display_name }))
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
    const messages = toAnthropicMessages(
      request.messages.filter((m) => m.role !== "system"),
    );

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: this.headers({
        "content-type": "application/json",
        accept: "text/event-stream",
      }),
      body: JSON.stringify({
        model: request.model,
        max_tokens: this.maxTokens,
        stream: true,
        messages,
        ...(system.length > 0 ? { system } : {}),
        ...(request.tools && request.tools.length > 0
          ? { tools: request.tools.map(toAnthropicTool) }
          : {}),
        ...(request.temperature !== undefined
          ? { temperature: request.temperature }
          : {}),
      }),
      signal: request.signal ?? null,
    });
    if (!res.ok || !res.body) throw await this.toProviderError(res);

    const blocks = new Map<
      number,
      { kind: "text" } | { kind: "tool_use"; id: string; name: string; args: string }
    >();
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason = "end_turn";

    for await (const data of parseSSE(res.body)) {
      let event: AnthropicEvent;
      try {
        event = JSON.parse(data) as AnthropicEvent;
      } catch {
        continue;
      }
      switch (event.type) {
        case "message_start":
          inputTokens = event.message?.usage?.input_tokens ?? inputTokens;
          outputTokens = event.message?.usage?.output_tokens ?? outputTokens;
          break;
        case "content_block_start": {
          const idx = event.index ?? 0;
          const block = event.content_block;
          if (block?.type === "tool_use") {
            blocks.set(idx, {
              kind: "tool_use",
              id: block.id ?? `toolu_${idx}`,
              name: block.name ?? "",
              args: "",
            });
          } else {
            blocks.set(idx, { kind: "text" });
          }
          break;
        }
        case "content_block_delta": {
          const idx = event.index ?? 0;
          const delta = event.delta ?? {};
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            handlers.onText?.(delta.text);
          } else if (
            delta.type === "input_json_delta" &&
            typeof delta.partial_json === "string"
          ) {
            const block = blocks.get(idx);
            if (block?.kind === "tool_use") block.args += delta.partial_json;
          }
          break;
        }
        case "content_block_stop": {
          const idx = event.index ?? 0;
          const block = blocks.get(idx);
          if (block?.kind === "tool_use") {
            handlers.onToolCall?.({
              id: block.id,
              name: block.name,
              arguments: block.args.length > 0 ? block.args : "{}",
            });
          }
          blocks.delete(idx);
          break;
        }
        case "message_delta":
          if (event.delta?.stop_reason) finishReason = event.delta.stop_reason;
          outputTokens = event.usage?.output_tokens ?? outputTokens;
          break;
        case "error":
          throw new ProviderError(
            0,
            `Anthropic stream error: ${event.error?.message ?? "unknown"}`,
          );
        default:
          break; // ping, message_stop, …
      }
    }

    handlers.onUsage?.({ inputTokens, outputTokens });
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
      401: "Invalid or missing Anthropic API key. Set ANTHROPIC_API_KEY or `avery config set anthropicApiKey <key>`.",
      403: "Access denied by Anthropic — check your plan and model access.",
      404: "Unknown Anthropic model. Check `avery models --provider anthropic`.",
      429: "Rate limited by Anthropic — retry in a few seconds.",
    };
    const message = `Anthropic request failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 500)}` : ""}`;
    return new ProviderError(res.status, message, hints[res.status]);
  }
}

function toAnthropicTool(t: ToolSpec): Record<string, unknown> {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  };
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

/** Convert chat history; consecutive tool results merge into one user message. */
export function toAnthropicMessages(
  messages: ChatMessage[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: m.content ?? "",
      };
      const prev = out[out.length - 1];
      if (prev?.role === "user" && Array.isArray(prev.content)) {
        (prev.content as unknown[]).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (m.role === "assistant") {
      const content: unknown[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) {
        content.push({
          type: "tool_use",
          id: c.id,
          name: c.name,
          input: safeParseArgs(c.arguments),
        });
      }
      out.push({
        role: "assistant",
        content: content.length > 0 ? content : [{ type: "text", text: " " }],
      });
      continue;
    }
    if (m.role === "user") {
      out.push({ role: "user", content: m.content ?? "" });
    }
  }
  return out;
}
