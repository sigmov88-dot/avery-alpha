import { DEFAULT_BASE_URL } from "../config/index.ts";
import { OpenAIProvider } from "./openai.ts";

/**
 * OpenCode ZEN provider — облачный шлюз курируемых моделей.
 * OpenAI-compatible API at https://opencode.ai/zen/v1.
 * See https://opencode.ai/docs/zen
 *
 * Провайдер по умолчанию для пользователей Avery.
 */
export class ZenProvider extends OpenAIProvider {
  constructor(opts: { apiKey: string; baseUrl?: string }) {
    super({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl ?? DEFAULT_BASE_URL,
      name: "opencode-zen",
      label: "OpenCode ZEN",
      hints: {
        401: "Invalid or missing API key. Run `avery auth login` or set OPENCODE_API_KEY.",
        402: "Insufficient OpenCode ZEN credits. Top up at https://opencode.ai",
        403: "Access denied — the model may be disabled for your ZEN workspace.",
        404: "Unknown model or endpoint. Check `avery models` and your baseUrl.",
        429: "Rate limited by OpenCode ZEN — retry in a few seconds.",
      },
    });
  }
}
