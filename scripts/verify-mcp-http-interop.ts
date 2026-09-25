/** Run with: bun scripts/verify-mcp-http-interop.ts /path/to/official-sdk/dist/esm */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createMcpHttpClient } from "../packages/core/src/mcp-http.js";

const root = process.argv[2];
if (!root) throw new Error("Pass the installed official @modelcontextprotocol/sdk dist/esm directory.");
const { McpServer, ResourceTemplate } = await import(pathToFileURL(resolve(root, "server/mcp.js")).href);
const { WebStandardStreamableHTTPServerTransport } = await import(pathToFileURL(resolve(root, "server/webStandardStreamableHttp.js")).href);
for (const enableJsonResponse of [true, false]) {
  const server = new McpServer({ name: "official-sdk-fixture", version: "1.27.1" });
  server.registerTool("hello", {}, async () => ({ content: [{ type: "text", text: "hello" }] }));
  server.registerResource("text", "fixture://text", {}, async () => ({ contents: [{ uri: "fixture://text", text: "content" }] }));
  server.registerResource("binary", "fixture://binary", {}, async () => ({ contents: [{ uri: "fixture://binary", blob: "aGk=", mimeType: "application/octet-stream" }] }));
  server.registerResource("templated", new ResourceTemplate("fixture://{name}", { list: undefined }), {}, async (uri: URL) => ({ contents: [{ uri: uri.href, text: "template" }] }));
  server.registerPrompt("greeting", {}, async () => ({ messages: [{ role: "user", content: { type: "text", text: "hello" } }] }));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse });
  await server.connect(transport);
  const client = createMcpHttpClient({ url: "https://official-fixture.test/mcp", fetch: (async (url, init) => transport.handleRequest(new Request(url, init))) as typeof fetch });
  try {
    assert.equal((await client.listTools() as { tools: unknown[] }).tools.length, 1);
    assert.equal((await client.callTool({ name: "hello" }) as { content: Array<{ text: string }> }).content[0].text, "hello");
    assert.equal((await client.listResources!()).resources.length, 2);
    assert.equal((await client.listResourceTemplates!()).resourceTemplates.length, 1);
    assert.equal((await client.readResource!({ uri: "fixture://text" })).contents[0].text, "content");
    assert.equal((await client.readResource!({ uri: "fixture://binary" })).contents[0].blob, "aGk=");
    assert.equal((await client.listPrompts!()).prompts.length, 1);
    assert.equal((await client.getPrompt!({ name: "greeting" })).messages.length, 1);
    console.log(`Official MCP SDK 1.27.1 ${enableJsonResponse ? "JSON" : "SSE"}: tools, resources, templates, prompts passed`);
  } finally { client.close(); await server.close(); }
}
