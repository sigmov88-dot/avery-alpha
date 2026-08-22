// Mock MCP server: newline-delimited JSON-RPC over stdio.
// Handles initialize / tools/list / tools/call, ignores notifications.
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === undefined) continue; // notification
    let result;
    if (msg.method === "initialize") {
      result = {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mock", version: "1.0.0" },
      };
    } else if (msg.method === "tools/list") {
      result = {
        tools: [
          {
            name: "echo",
            description: "Echo back text",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
            },
            annotations: { readOnlyHint: true },
          },
          {
            name: "explode",
            description: "Always fails",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
    } else if (msg.method === "tools/call") {
      if (msg.params?.name === "echo") {
        result = {
          content: [{ type: "text", text: "echo:" + (msg.params?.arguments?.text ?? "") }],
        };
      } else {
        result = { content: [{ type: "text", text: "boom" }], isError: true };
      }
    } else {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: "method not found" },
        }) + "\n",
      );
      continue;
    }
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n",
    );
  }
});
