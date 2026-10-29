import { createServer } from "node:http";
import { once } from "node:events";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { expect, test } from "vitest";
import { createMcpHttpClient } from "../packages/core/src/mcp-http.js";

test.each([true, false])("official MCP Node HTTP bridge supports JSON response mode %s", async (enableJsonResponse) => {
  const server = new McpServer({ name: "node-http-fixture", version: "1.0.0" });
  server.registerTool("hello", {}, async () => ({ content: [{ type: "text", text: "hello" }] }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse });
  await server.connect(transport);
  const http = createServer((request, response) => {
    void transport.handleRequest(request, response).catch(() => {
      response.statusCode = 500;
      response.end();
    });
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  const client = createMcpHttpClient({
    url: "https://node-http-fixture.test/mcp",
    fetch: ((_url, init) => fetch(`http://127.0.0.1:${address.port}/mcp`, init)) as typeof fetch
  });
  try {
    expect((await client.listTools() as { tools: unknown[] }).tools).toHaveLength(1);
    expect((await client.callTool({ name: "hello" }) as { content: { text: string }[] }).content[0]?.text).toBe("hello");
  } finally {
    client.close();
    await server.close();
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
  }
});
