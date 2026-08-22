import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { OllamaProvider } from "../src/provider/ollama.ts";
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

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

test("listModels maps /api/tags entries", async () => {
  await withServer(
    (req, res) => {
      assert.equal(req.url, "/api/tags");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          models: [
            { name: "qwen3:4b", details: { parameter_size: "4B" } },
            { name: "llama3.1:latest", details: { parameter_size: "8B" } },
          ],
        }),
      );
    },
    async (base) => {
      const p = new OllamaProvider({ baseUrl: base });
      const models = await p.listModels();
      assert.deepEqual(
        models.map((m) => m.id),
        ["llama3.1:latest", "qwen3:4b"],
      );
      assert.match(models[0]?.name ?? "", /8B/);
    },
  );
});

test("streamChat parses NDJSON: text, tool calls (object args), usage", async () => {
  const ndjson =
    [
      '{"message":{"role":"assistant","content":"При"},"done":false}',
      '{"message":{"role":"assistant","content":"вет"},"done":false}',
      '{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"read_file","arguments":{"path":"a.ts"}}}]} ,"done":false}',
      '{"message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","prompt_eval_count":12,"eval_count":7}',
      "",
    ].join("\n");

  await withServer(
    async (req, res) => {
      assert.equal(req.url, "/api/chat");
      assert.equal(req.method, "POST");
      const parsed = JSON.parse(await readBody(req)) as {
        model: string;
        stream: boolean;
        messages: Array<Record<string, any>>;
        tools: Array<Record<string, any>>;
      };
      assert.equal(parsed.model, "llama3.1");
      assert.equal(parsed.stream, true);
      // assistant history serializes tool_calls with OBJECT arguments (Ollama format)
      assert.deepEqual(
        parsed.messages[1]?.tool_calls?.[0]?.function?.arguments,
        { path: "a.ts" },
      );
      // tool results carry the tool name
      assert.equal(parsed.messages[2]?.role, "tool");
      assert.equal(parsed.messages[2]?.name, "read_file");
      assert.equal(parsed.tools[0]?.function?.name, "read_file");
      res.setHeader("content-type", "application/x-ndjson");
      res.end(ndjson);
    },
    async (base) => {
      const p = new OllamaProvider({ baseUrl: base });
      let text = "";
      const calls: ToolCall[] = [];
      let usage: Usage | undefined;
      const { finishReason } = await p.streamChat(
        {
          model: "llama3.1",
          messages: [
            { role: "user", content: "прочитай a.ts" },
            {
              role: "assistant",
              content: null,
              toolCalls: [
                { id: "c9", name: "read_file", arguments: '{"path":"a.ts"}' },
              ],
            },
            {
              role: "tool",
              toolCallId: "c9",
              name: "read_file",
              content: "file body",
            },
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
      assert.equal(text, "Привет");
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.name, "read_file");
      // arguments are normalized to a JSON string for the agent loop
      assert.equal(calls[0]?.arguments, '{"path":"a.ts"}');
      assert.deepEqual(usage, { inputTokens: 12, outputTokens: 7 });
      assert.equal(finishReason, "stop");
    },
  );
});

test("connection refused maps to a helpful ProviderError", async () => {
  // grab a port, then close the server so nothing listens there
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));

  const p = new OllamaProvider({ baseUrl: `http://127.0.0.1:${port}` });
  await assert.rejects(
    () => p.listModels(),
    (e: unknown) => {
      assert.ok(e instanceof ProviderError);
      assert.match(e.message, /Ollama/);
      assert.match(e.hint ?? "", /ollama serve/);
      return true;
    },
  );
});

test("HTTP 404 hints at ollama pull", async () => {
  await withServer(
    (_req, res) => {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "model 'nope' not found" }));
    },
    async (base) => {
      const p = new OllamaProvider({ baseUrl: base });
      await assert.rejects(
        () =>
          p.streamChat(
            { model: "nope", messages: [{ role: "user", content: "x" }] },
            {},
          ),
        (e: unknown) => {
          assert.ok(e instanceof ProviderError);
          assert.match(e.hint ?? "", /ollama pull nope/);
          return true;
        },
      );
    },
  );
});
