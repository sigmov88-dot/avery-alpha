import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { GeminiProvider, toGeminiContents } from "../src/provider/gemini.ts";
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

test("listModels strips models/ prefix and maps token limit", async () => {
  await withServer(
    (req, res) => {
      assert.equal(req.url, "/models");
      assert.equal(req.headers["x-goog-api-key"], "g-key");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          models: [
            {
              name: "models/gemini-2.5-pro",
              displayName: "Gemini 2.5 Pro",
              inputTokenLimit: 1048576,
            },
            { name: "models/gemini-flash", displayName: "Flash" },
          ],
        }),
      );
    },
    async (base) => {
      const p = new GeminiProvider({ apiKey: "g-key", baseUrl: base });
      const models = await p.listModels();
      assert.deepEqual(
        models.map((m) => m.id),
        ["gemini-2.5-pro", "gemini-flash"],
      );
      assert.equal(models[0]?.contextWindow, 1048576);
    },
  );
});

test("streamChat: functionDeclarations request, SSE stream with functionCall", async () => {
  const sse =
    [
      'data: {"candidates":[{"content":{"parts":[{"text":"Секунду"}],"role":"model"}}]}',
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"ls","args":{"path":"."}}}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3}}',
      "",
    ].join("\n\n");

  await withServer(
    async (req, res) => {
      assert.equal(
        req.url,
        "/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
      );
      const body = JSON.parse(await readBody(req)) as {
        systemInstruction?: { parts: Array<{ text: string }> };
        contents: Array<Record<string, any>>;
        tools: Array<{ functionDeclarations: Array<Record<string, any>> }>;
      };
      assert.equal(body.systemInstruction?.parts[0]?.text, "be brief");
      assert.equal(body.tools[0]?.functionDeclarations[0]?.name, "ls");
      // история: user, model(functionCall), user(functionResponse)
      assert.equal(body.contents[1]?.role, "model");
      assert.equal(body.contents[1]?.parts?.[0]?.functionCall?.name, "ls");
      assert.equal(body.contents[2]?.role, "user");
      assert.equal(
        body.contents[2]?.parts?.[0]?.functionResponse?.name,
        "ls",
      );
      assert.deepEqual(
        body.contents[2]?.parts?.[0]?.functionResponse?.response,
        { result: "file list" },
      );
      res.setHeader("content-type", "text/event-stream");
      res.end(sse);
    },
    async (base) => {
      const p = new GeminiProvider({ apiKey: "k", baseUrl: base });
      let text = "";
      const calls: ToolCall[] = [];
      const usages: Usage[] = [];
      const { finishReason } = await p.streamChat(
        {
          model: "gemini-2.5-pro",
          messages: [
            { role: "system", content: "be brief" },
            { role: "user", content: "list files" },
            {
              role: "assistant",
              content: null,
              toolCalls: [{ id: "g1", name: "ls", arguments: '{"path":"."}' }],
            },
            { role: "tool", toolCallId: "g1", name: "ls", content: "file list" },
          ],
          tools: [{ name: "ls", description: "d", parameters: { type: "object" } }],
        },
        {
          onText: (t) => (text += t),
          onToolCall: (c) => calls.push(c),
          onUsage: (u) => usages.push(u),
        },
      );
      assert.equal(text, "Секунду");
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.name, "ls");
      assert.equal(calls[0]?.arguments, '{"path":"."}');
      assert.deepEqual(usages, [{ inputTokens: 5, outputTokens: 3 }]);
      assert.equal(finishReason, "STOP");
    },
  );
});

test("HTTP 403 maps to a key hint", async () => {
  await withServer(
    (_req, res) => {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: { message: "API key not valid" } }));
    },
    async (base) => {
      const p = new GeminiProvider({ apiKey: "bad", baseUrl: base });
      await assert.rejects(
        () => p.listModels(),
        (e: unknown) => {
          assert.ok(e instanceof ProviderError);
          assert.equal(e.status, 403);
          assert.match(e.hint ?? "", /GEMINI_API_KEY/);
          return true;
        },
      );
    },
  );
});

test("toGeminiContents converts plain messages", () => {
  const out = toGeminiContents([
    { role: "user", content: "привет" },
    { role: "assistant", content: "здорово" },
  ]);
  assert.deepEqual(out, [
    { role: "user", parts: [{ text: "привет" }] },
    { role: "model", parts: [{ text: "здорово" }] },
  ]);
});
