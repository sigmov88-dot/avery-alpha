import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { OpenAIProvider } from "../src/provider/openai.ts";
import type { ToolCall, Usage } from "../src/provider/types.ts";
import { ProviderError } from "../src/provider/types.ts";

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

test("listModels sends auth and extra headers", async () => {
  await withServer(
    (req, res) => {
      assert.equal(req.url, "/models");
      assert.equal(req.headers.authorization, "Bearer sk-test");
      assert.equal(req.headers["x-tenant"], "t1");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "gpt-x" }, { id: "gpt-a" }] }));
    },
    async (base) => {
      const p = new OpenAIProvider({
        apiKey: "sk-test",
        baseUrl: base,
        headers: { "x-tenant": "t1" },
      });
      const models = await p.listModels();
      assert.deepEqual(
        models.map((m) => m.id),
        ["gpt-a", "gpt-x"],
      );
    },
  );
});

test("no apiKey → no authorization header (custom local servers)", async () => {
  await withServer(
    (req, res) => {
      assert.equal(req.headers.authorization, undefined);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "local-model" }] }));
    },
    async (base) => {
      const p = new OpenAIProvider({ baseUrl: base, name: "custom:local" });
      const models = await p.listModels();
      assert.equal(models[0]?.id, "local-model");
      assert.equal(p.name, "custom:local");
    },
  );
});

test("streamChat assembles text, tool calls and usage", async () => {
  const sse =
    [
      'data: {"choices":[{"delta":{"content":"Hi"}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}',
      "data: [DONE]",
      "",
    ].join("\n\n");

  await withServer(
    (req, res) => {
      assert.equal(req.url, "/chat/completions");
      assert.equal(req.method, "POST");
      res.setHeader("content-type", "text/event-stream");
      res.end(sse);
    },
    async (base) => {
      const p = new OpenAIProvider({ apiKey: "k", baseUrl: base });
      let text = "";
      const calls: ToolCall[] = [];
      let usage: Usage | undefined;
      const { finishReason } = await p.streamChat(
        { model: "gpt-5", messages: [{ role: "user", content: "hi" }] },
        {
          onText: (t) => (text += t),
          onToolCall: (c) => calls.push(c),
          onUsage: (u) => (usage = u),
        },
      );
      assert.equal(text, "Hi");
      assert.equal(calls[0]?.name, "bash");
      assert.equal(calls[0]?.arguments, '{"command":"ls"}');
      assert.deepEqual(usage, { inputTokens: 4, outputTokens: 2, cost: undefined });
      assert.equal(finishReason, "tool_calls");
    },
  );
});

test("label is used in error messages", async () => {
  await withServer(
    (_req, res) => {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: "no such model" } }));
    },
    async (base) => {
      const p = new OpenAIProvider({
        apiKey: "k",
        baseUrl: base,
        label: "myserver",
      });
      await assert.rejects(
        () => p.listModels(),
        (e: unknown) => {
          assert.ok(e instanceof ProviderError);
          assert.match(e.message, /^myserver request failed \(HTTP 404\)/);
          assert.match(e.message, /no such model/);
          return true;
        },
      );
    },
  );
});
