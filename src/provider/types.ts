export interface JSONSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cost?: number;
}

export interface ModelInfo {
  id: string;
  name?: string;
  contextWindow?: number;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  signal?: AbortSignal;
}

export interface ChatStreamHandlers {
  onText?: (text: string) => void;
  onToolCall?: (call: ToolCall) => void;
  onUsage?: (usage: Usage) => void;
}

export interface Provider {
  readonly name: string;
  listModels(opts?: { signal?: AbortSignal }): Promise<ModelInfo[]>;
  streamChat(
    request: ChatRequest,
    handlers: ChatStreamHandlers,
  ): Promise<{ finishReason: string }>;
}

export class ProviderError extends Error {
  readonly status: number;
  readonly hint?: string;

  constructor(status: number, message: string, hint?: string) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.hint = hint;
  }
}
