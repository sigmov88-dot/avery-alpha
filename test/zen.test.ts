import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { ToolCall, Usage } from "../src/provider/types.ts";
import { ProviderError } from "../src/provider/types.ts";
import { ZenProvider } from "../src/provider/zen.ts";

async function withServer(
  handler: http.RequestListener,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 500);
      server.close(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

test("listModels maps and sorts the catalog, sends auth header", async () => {
  await withServer(
    (req, res) => {
      assert.equal(req.url, "/models");
      assert.equal(req.headers.authorization, "Bearer test-key");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: [{ id: "zeta" }, { id: "alpha", context_length: 200000 }],
        }),
      );
    },
    async (base) => {
      const p = new ZenProvider({ apiKey: "test-key", baseUrl: base });
      const models = await p.listModels();
      assert.deepEqual(
        models.map((m) => m.id),
        ["alpha", "zeta"],
      );
      assert.equal(models[0]?.contextWindow, 200000);
    },
  );
});

test("streamChat assembles text, tool calls, usage; serializes history", async () => {
  const sse =
    [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      'data: {"choices":[{"delta":{"content":" world"}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.ts\\"}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"cost":0.001}}',
      "data: [DONE]",
      "",
    ].join("\n\n");

  await withServer(
    async (req, res) => {
      assert.equal(req.url, "/chat/completions");
      assert.equal(req.method, "POST");
      const parsed = JSON.parse(await readBody(req)) as {
        model: string;
        stream: boolean;
        messages: Array<Record<string, any>>;
        tools: Array<Record<string, any>>;
      };
      assert.equal(parsed.model, "big-pickle");
      assert.equal(parsed.stream, true);
      // assistant tool-call history round-trips in OpenAI format
      assert.equal(parsed.messages[1]?.tool_calls?.[0]?.function?.name, "read_file");
      assert.equal(parsed.messages[2]?.tool_call_id, "c9");
      assert.equal(parsed.tools[0]?.type, "function");
      assert.equal(parsed.tools[0]?.function?.name, "read_file");
      res.setHeader("content-type", "text/event-stream");
      res.end(sse);
    },
    async (base) => {
      const p = new ZenProvider({ apiKey: "k", baseUrl: base });
      let text = "";
      const calls: ToolCall[] = [];
      let usage: Usage | undefined;
      const { finishReason } = await p.streamChat(
        {
          model: "big-pickle",
          messages: [
            { role: "user", content: "read a.ts" },
            {
              role: "assistant",
              content: null,
              toolCalls: [
                { id: "c9", name: "read_file", arguments: '{"path":"a.ts"}' },
              ],
            },
            { role: "tool", toolCallId: "c9", content: "file body" },
          ],
          tools: [
            {
              name: "read_file",
              description: "d",
              parameters: { type: "object" },
            },
          ],
        },
        {
          onText: (t) => (text += t),
          onToolCall: (c) => calls.push(c),
          onUsage: (u) => (usage = u),
        },
      );
      assert.equal(text, "Hello world");
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.id, "call_1");
      assert.equal(calls[0]?.name, "read_file");
      assert.equal(calls[0]?.arguments, '{"path":"a.ts"}');
      assert.deepEqual(usage, { inputTokens: 10, outputTokens: 5, cost: 0.001 });
      assert.equal(finishReason, "tool_calls");
    },
  );
});

test("HTTP 401 maps to ProviderError with a helpful hint", async () => {
  await withServer(
    (_req, res) => {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { message: "bad key" } }));
    },
    async (base) => {
      const p = new ZenProvider({ apiKey: "nope", baseUrl: base });
      await assert.rejects(
        () => p.listModels(),
        (e: unknown) => {
          assert.ok(e instanceof ProviderError);
          assert.equal(e.status, 401);
          assert.match(e.message, /bad key/);
          assert.match(e.hint ?? "", /auth login/);
          return true;
        },
      );
    },
  );
});

test("HTTP 429 maps to a rate-limit hint", async () => {
  await withServer(
    (_req, res) => {
      res.statusCode = 429;
      res.end("too many requests");
    },
    async (base) => {
      const p = new ZenProvider({ apiKey: "k", baseUrl: base });
      await assert.rejects(
        () =>
          p.streamChat({ model: "m", messages: [{ role: "user", content: "x" }] }, {}),
        (e: unknown) => {
          assert.ok(e instanceof ProviderError);
          assert.equal(e.status, 429);
          assert.match(e.hint ?? "", /[Rr]ate/);
          return true;
        },
      );
    },
  );
});
