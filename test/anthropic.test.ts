import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
  AnthropicProvider,
  toAnthropicMessages,
} from "../src/provider/anthropic.ts";
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

test("listModels hits /v1/models with anthropic headers", async () => {
  await withServer(
    (req, res) => {
      assert.equal(req.url, "/v1/models");
      assert.equal(req.headers["x-api-key"], "sk-ant-test");
      assert.equal(req.headers["anthropic-version"], "2023-06-01");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: [
            { id: "claude-b", display_name: "Claude B" },
            { id: "claude-a", display_name: "Claude A" },
          ],
        }),
      );
    },
    async (base) => {
      const p = new AnthropicProvider({ apiKey: "sk-ant-test", baseUrl: base });
      const models = await p.listModels();
      assert.deepEqual(
        models.map((m) => m.id),
        ["claude-a", "claude-b"],
      );
      assert.equal(models[0]?.name, "Claude A");
    },
  );
});

test("streamChat parses Anthropic SSE: text, tool_use, usage", async () => {
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "При" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "вет" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "read_file" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"a.ts"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ];
  const sse = events.map((e) => `data: ${JSON.stringify(e)}`).join("\n\n") + "\n\n";

  await withServer(
    async (req, res) => {
      assert.equal(req.url, "/v1/messages");
      const body = JSON.parse(await readBody(req)) as {
        model: string;
        stream: boolean;
        max_tokens: number;
        system?: string;
        messages: Array<Record<string, any>>;
        tools: Array<Record<string, any>>;
      };
      assert.equal(body.model, "claude-sonnet-4-5");
      assert.equal(body.stream, true);
      assert.ok(body.max_tokens > 0);
      assert.equal(body.system, "be brief");
      // tools → input_schema
      assert.equal(body.tools[0]?.name, "read_file");
      assert.ok(body.tools[0]?.input_schema);
      // история: user + assistant(tool_use) + merged user(2× tool_result)
      assert.equal(body.messages.length, 3);
      assert.equal(body.messages[1]?.role, "assistant");
      assert.equal(body.messages[1]?.content?.[1]?.type, "tool_use");
      assert.deepEqual(body.messages[1]?.content?.[1]?.input, { path: "a" });
      assert.equal(body.messages[2]?.role, "user");
      assert.equal(body.messages[2]?.content?.length, 2);
      assert.equal(body.messages[2]?.content?.[0]?.type, "tool_result");
      assert.equal(body.messages[2]?.content?.[0]?.tool_use_id, "t1");
      res.setHeader("content-type", "text/event-stream");
      res.end(sse);
    },
    async (base) => {
      const p = new AnthropicProvider({ apiKey: "k", baseUrl: base });
      let text = "";
      const calls: ToolCall[] = [];
      const usages: Usage[] = [];
      const { finishReason } = await p.streamChat(
        {
          model: "claude-sonnet-4-5",
          messages: [
            { role: "system", content: "be brief" },
            { role: "user", content: "hi" },
            {
              role: "assistant",
              content: "ok",
              toolCalls: [{ id: "t1", name: "read_file", arguments: '{"path":"a"}' }],
            },
            { role: "tool", toolCallId: "t1", name: "read_file", content: "b1" },
            { role: "tool", toolCallId: "t2", name: "read_file", content: "b2" },
          ],
          tools: [
            { name: "read_file", description: "d", parameters: { type: "object" } },
          ],
        },
        {
          onText: (t) => (text += t),
          onToolCall: (c) => calls.push(c),
          onUsage: (u) => usages.push(u),
        },
      );
      assert.equal(text, "Привет");
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.id, "toolu_1");
      assert.equal(calls[0]?.name, "read_file");
      assert.equal(calls[0]?.arguments, '{"path":"a.ts"}');
      assert.deepEqual(usages, [{ inputTokens: 12, outputTokens: 7 }]);
      assert.equal(finishReason, "tool_use");
    },
  );
});

test("HTTP 401 maps to a key hint", async () => {
  await withServer(
    (_req, res) => {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { message: "invalid x-api-key" } }));
    },
    async (base) => {
      const p = new AnthropicProvider({ apiKey: "nope", baseUrl: base });
      await assert.rejects(
        () => p.listModels(),
        (e: unknown) => {
          assert.ok(e instanceof ProviderError);
          assert.equal(e.status, 401);
          assert.match(e.message, /invalid x-api-key/);
          assert.match(e.hint ?? "", /ANTHROPIC_API_KEY/);
          return true;
        },
      );
    },
  );
});

test("toAnthropicMessages keeps plain user/assistant text", () => {
  const out = toAnthropicMessages([
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
  ]);
  assert.deepEqual(out, [
    { role: "user", content: "hello" },
    { role: "assistant", content: [{ type: "text", text: "hi there" }] },
  ]);
});
