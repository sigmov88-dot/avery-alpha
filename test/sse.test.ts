import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSSE } from "../src/provider/sse.ts";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

test("parseSSE yields data payloads across chunk boundaries", async () => {
  const events: string[] = [];
  for await (const ev of parseSSE(
    streamOf(["data: hel", "lo\n\ndata: world\n", "\ndata: [DONE]\n\n"]),
  )) {
    events.push(ev);
  }
  assert.deepEqual(events, ["hello", "world", "[DONE]"]);
});

test("parseSSE joins multi-line data and ignores comments", async () => {
  const events: string[] = [];
  for await (const ev of parseSSE(streamOf([": ping\n\ndata: a\ndata: b\n\n"]))) {
    events.push(ev);
  }
  assert.deepEqual(events, ["a\nb"]);
});

test("parseSSE handles CRLF line endings", async () => {
  const events: string[] = [];
  for await (const ev of parseSSE(streamOf(["data: x\r\n\r\n"]))) {
    events.push(ev);
  }
  assert.deepEqual(events, ["x"]);
});

test("parseSSE flushes a trailing event without blank line", async () => {
  const events: string[] = [];
  for await (const ev of parseSSE(streamOf(["data: tail"]))) {
    events.push(ev);
  }
  assert.deepEqual(events, ["tail"]);
});
