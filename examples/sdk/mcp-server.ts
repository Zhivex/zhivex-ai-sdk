import { Agent, createMockLanguageModel, tool } from "../../packages/core/src/index.ts";
import { createMcpHttpClient } from "../../packages/core/src/mcp-http.ts";
import {
  createMcpHttpServer,
  createMcpServer,
  createMcpStdioServer,
  McpServerError
} from "../../packages/core/src/mcp-server.ts";
import { z } from "zod";

import { section } from "../_shared.ts";

/**
 * Experimental MCP server. A mock model and an in-process client exercise
 * tools, an approval refusal, and an agent-as-tool over Streamable HTTP, then
 * the same echo tool over newline-delimited stdio.
 *
 * Published applications import `@zhivex-ai/sdk/mcp-server` and
 * `@zhivex-ai/sdk/mcp-http`. This file imports workspace source so it runs
 * before `dist/` exists. It does not need provider credentials.
 *
 *   bun run examples/sdk/mcp-server.ts
 */

const echo = tool({
  name: "echo",
  description: "Repeat text",
  schema: z.object({ text: z.string() }),
  execute: async ({ text }) => ({ text })
});

const deploy = tool({
  name: "deploy",
  description: "Deploy a target after approval",
  schema: z.object({ target: z.string() }),
  requiresApproval: true,
  approvalMode: "interrupt",
  execute: async () => {
    throw new Error("deploy must not run");
  }
});

const helper = new Agent({
  name: "helper",
  instructions: "Answer with the mock model.",
  model: createMockLanguageModel({
    streamEvents: [[
      { type: "text-delta", textDelta: "Hello " },
      { type: "text-delta", textDelta: "from the agent" },
      { type: "finish", finishReason: "stop" }
    ]]
  })
});

const httpServer = createMcpServer({
  name: "zhivex-example",
  version: "0.0.0-experimental",
  instructions: "Experimental Zhivex tools and agents.",
  tools: { echo, deploy },
  agents: {
    helper: { agent: helper, description: "Deterministic helper" }
  }
});

const http = createMcpHttpServer(httpServer, {
  allowedHosts: ["mcp.test"],
  authenticate(request) {
    if (request.headers.get("authorization") !== "Bearer example") {
      throw new McpServerError("AUTH_REQUIRED", "Bearer token required.");
    }
  }
});

const client = createMcpHttpClient({
  url: "https://mcp.test/mcp",
  auth: {
    getAccessToken: async () => "example"
  },
  fetch: (async (url: string | URL | Request, init?: RequestInit) =>
    http.fetch(new Request(url, init))) as typeof fetch
});

section("Streamable HTTP");
const listed = await client.listTools();
console.log(listed.tools.map((entry) => entry.name).join(", "));
const echoed = await client.callTool({ name: "echo", arguments: { text: "hello" } });
console.log(echoed.structuredContent);
const blocked = await client.callTool({ name: "deploy", arguments: { target: "prod" } });
console.log(blocked.structuredContent);
const agent = await client.callTool({ name: "helper", arguments: { prompt: "Say hello" } });
console.log(agent.content);
client.close();
await http.close();

if (echoed.structuredContent?.text !== "hello") {
  throw new Error("echo tool did not return its input");
}
if (blocked.isError !== true || blocked.structuredContent?.code !== "APPROVAL_REQUIRED") {
  throw new Error("approval-gated tool was not refused");
}
const agentText = agent.content[0];
if (!agentText || agentText.type !== "text" || agentText.text !== "Hello from the agent") {
  throw new Error("agent tool did not return the mock text");
}

section("stdio");
const stdioServer = createMcpServer({
  name: "zhivex-stdio",
  version: "0.0.0-experimental",
  tools: { echo }
});
const input = new TransformStream<Uint8Array, Uint8Array>();
const output = new TransformStream<Uint8Array, Uint8Array>();
const session = createMcpStdioServer({
  server: stdioServer,
  input: input.readable,
  output: output.writable
});
const writer = input.writable.getWriter();
const reader = output.readable.getReader();
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let buffered = "";

const send = async (message: unknown) => {
  await writer.write(encoder.encode(`${JSON.stringify(message)}\n`));
};

const nextMessage = async (): Promise<{ result?: { structuredContent?: { text?: string } } }> => {
  while (!buffered.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("stdio server closed");
    buffered += decoder.decode(chunk.value, { stream: true });
  }
  const newline = buffered.indexOf("\n");
  const line = buffered.slice(0, newline);
  buffered = buffered.slice(newline + 1);
  return JSON.parse(line) as { result?: { structuredContent?: { text?: string } } };
};

await send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "example", version: "1" }
  }
});
await nextMessage();
await send({ jsonrpc: "2.0", method: "notifications/initialized" });
await send({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "echo", arguments: { text: "stdio" } }
});
const stdioResult = await nextMessage();
console.log(stdioResult.result?.structuredContent);
await writer.close();
await session.close();

if (stdioResult.result?.structuredContent?.text !== "stdio") {
  throw new Error("stdio echo did not return its input");
}
