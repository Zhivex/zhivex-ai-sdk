import { PassThrough } from "node:stream";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { Agent, createMockLanguageModel, tool } from "../src/index.js";
import { hostedTool } from "../src/messages.js";
import { createMcpHttpClient, McpHttpError } from "../src/mcp-http.js";
import {
  createMcpHttpServer,
  createMcpServer,
  createMcpStdioServer,
  McpServerError,
  MCP_SERVER_PROTOCOL_VERSION,
  type McpServer
} from "../src/mcp-server.js";
import { serveMcpStdio } from "../src/mcp-server-stdio.js";
import * as browserStub from "../src/mcp-server-stdio-browser.js";

const execFileAsync = promisify(execFile);
const sourceRoot = path.resolve(import.meta.dirname, "../src");

const fetchHandler = (fetch: (request: Request) => Promise<Response>) =>
  (async (url: string | URL | Request, init?: RequestInit) => fetch(new Request(url, init))) as typeof fetch;

const useHttp = async <T>(server: McpServer, run: (client: ReturnType<typeof createMcpHttpClient>) => Promise<T>, options?: Parameters<typeof createMcpHttpServer>[1]) => {
  const http = createMcpHttpServer(server, options);
  const client = createMcpHttpClient({
    url: "https://mcp.test/mcp",
    fetch: fetchHandler((request) => http.fetch(request))
  });
  try {
    return await run(client);
  } finally {
    client.close();
    await http.close();
  }
};

describe("experimental MCP server", () => {
  it("roundtrips tools over Streamable HTTP and converts Zod schemas", async () => {
    let calls = 0;
    const server = createMcpServer({
      name: "fixture",
      version: "0.0.0-test",
      tools: {
        echo: tool({
          name: "echo",
          description: "Repeat text",
          schema: z.object({ text: z.string().describe("Text to repeat") }),
          execute: async ({ text }) => {
            calls += 1;
            return { text };
          }
        })
      }
    });
    const listed = await useHttp(server, async (client) => {
      const page = await client.listTools();
      const invalid = await client.callTool({ name: "echo", arguments: {} });
      const echoed = await client.callTool({ name: "echo", arguments: { text: "hi" } });
      return { page, invalid, echoed };
    });
    const echo = listed.page.tools.find((entry) => entry.name === "echo");
    expect(echo?.description).toBe("Repeat text");
    expect(echo?.inputSchema).toMatchObject({
      type: "object",
      properties: { text: { type: "string", description: "Text to repeat" } },
      required: ["text"]
    });
    expect(echo?.inputSchema).not.toHaveProperty("$schema");
    expect(listed.invalid.isError).toBe(true);
    expect(listed.invalid.structuredContent).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(listed.echoed.structuredContent).toEqual({ text: "hi" });
    expect(calls).toBe(1);
    expect(MCP_SERVER_PROTOCOL_VERSION).toBe("2025-11-25");
  });

  it("does not execute tools or agents that require approval", async () => {
    let toolCalls = 0;
    const server = createMcpServer({
      tools: {
        deploy: tool({
          name: "deploy",
          schema: z.object({ target: z.string() }),
          requiresApproval: true,
          approvalMode: "interrupt",
          execute: async () => {
            toolCalls += 1;
            return { ok: true };
          }
        })
      },
      agents: {
        reviewer: {
          name: "reviewer",
          requiresApproval: true,
          agent: new Agent({
            name: "reviewer",
            model: createMockLanguageModel({
              streamEvents: [[{ type: "text-delta", textDelta: "should-not-run" }, { type: "finish", finishReason: "stop" }]]
            })
          })
        }
      }
    });
    const result = await useHttp(server, async (client) => {
      const deploy = await client.callTool({ name: "deploy", arguments: { target: "prod" } });
      const reviewer = await client.callTool({ name: "reviewer", arguments: { prompt: "go" } });
      return { deploy, reviewer };
    });
    expect(toolCalls).toBe(0);
    expect(result.deploy.isError).toBe(true);
    expect(result.deploy.structuredContent).toMatchObject({
      code: "APPROVAL_REQUIRED",
      tool: "deploy",
      approvalMode: "interrupt",
      executed: false
    });
    expect(result.reviewer.structuredContent).toMatchObject({ code: "APPROVAL_REQUIRED", executed: false });
  });

  it("pauses an agent tool call without executing an approval-gated tool", async () => {
    let deploys = 0;
    const server = createMcpServer({
      agents: {
        operator: {
          description: "Deploys after approval",
          agent: new Agent({
            name: "operator",
            model: createMockLanguageModel({
              streamEvents: [[
                { type: "tool-call", toolCall: { id: "call_1", name: "deploy", input: { target: "prod" } } },
                { type: "finish", finishReason: "tool-calls" }
              ]]
            }),
            tools: {
              deploy: tool({
                name: "deploy",
                schema: z.object({ target: z.string() }),
                requiresApproval: true,
                approvalMode: "interrupt",
                execute: async () => {
                  deploys += 1;
                  return { ok: true };
                }
              })
            }
          })
        }
      }
    });
    const result = await useHttp(server, (client) => client.callTool({
      name: "operator",
      arguments: { prompt: "Deploy production." }
    }));
    expect(deploys).toBe(0);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: "APPROVAL_REQUIRED",
      status: "waiting_approval",
      executed: true
    });
    expect(result.structuredContent?.approvals).toEqual([
      expect.objectContaining({ name: "deploy", kind: "local-tool" })
    ]);
    expect(JSON.stringify(result.structuredContent)).not.toContain("prod");
  });

  it("streams agent progress to an official MCP client and returns the final text", async () => {
    const server = createMcpServer({
      agents: {
        helper: {
          agent: new Agent({
            name: "helper",
            model: createMockLanguageModel({
              streamEvents: [[
                { type: "text-delta", textDelta: "Hello " },
                { type: "text-delta", textDelta: "world" },
                { type: "finish", finishReason: "stop" }
              ]]
            })
          })
        }
      }
    });
    const http = createMcpHttpServer(server);
    const transport = new StreamableHTTPClientTransport(new URL("https://mcp.test/mcp"), {
      fetch: fetchHandler((request) => http.fetch(request))
    });
    const client = new Client({ name: "official-client", version: "1.32.1" });
    const progress: string[] = [];
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((entry) => entry.name)).toEqual(["helper"]);
      const result = await client.callTool(
        { name: "helper", arguments: { prompt: "Say hello" } },
        undefined,
        { onprogress: (update) => { if (update.message) progress.push(update.message); } }
      );
      expect(result.isError).toBeUndefined();
      expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "Hello world" })]);
      expect(progress).toEqual(["Hello", "world"]);
    } finally {
      await client.close();
      await http.close();
    }
  });

  it("enforces auth, host allowlists, byte limits, and time limits", async () => {
    const server = createMcpServer({
      timeoutMs: 30,
      maxResultBytes: 32,
      tools: {
        hang: tool({
          name: "hang",
          schema: z.object({}),
          execute: () => new Promise(() => undefined)
        }),
        huge: tool({
          name: "huge",
          schema: z.object({}),
          execute: () => ({ value: "x".repeat(200) })
        })
      }
    });
    const http = createMcpHttpServer(server, {
      maxRequestBytes: 200,
      allowedHosts: ["mcp.test"],
      authenticate: (request) => {
        const header = request.headers.get("authorization");
        if (header === "Bearer reject") throw new McpServerError("AUTH_REJECTED", "no");
        if (header !== "Bearer ok") throw new McpServerError("AUTH_REQUIRED", "no");
      }
    });
    const call = (init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("content-type", "application/json");
      headers.set("accept", "application/json, text/event-stream");
      return http.fetch(new Request("https://mcp.test/mcp", { method: "POST", ...init, headers }));
    };
    const unauthenticated = await call({ body: "{}" });
    expect(unauthenticated.status).toBe(401);
    const rejected = await call({ headers: { authorization: "Bearer reject" }, body: "{}" });
    expect(rejected.status).toBe(403);
    const foreignHost = await http.fetch(new Request("https://evil.test/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        authorization: "Bearer ok",
        Host: "evil.test"
      },
      body: "{}"
    }));
    expect(foreignHost.status).toBe(403);
    const oversized = await call({
      headers: { authorization: "Bearer ok" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { blob: "x".repeat(200) } })
    });
    expect(oversized.status).toBe(413);
    const get = await http.fetch(new Request("https://mcp.test/mcp", {
      method: "GET",
      headers: { authorization: "Bearer ok", Host: "mcp.test", Accept: "text/event-stream" }
    }));
    expect(get.status).toBe(405);

    const authed = createMcpHttpClient({
      url: "https://mcp.test/mcp",
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set("authorization", "Bearer ok");
        return http.fetch(new Request(url, { ...init, headers }));
      }) as typeof fetch
    });
    try {
      const timedOut = await authed.callTool({ name: "hang", arguments: {} });
      const limited = await authed.callTool({ name: "huge", arguments: {} });
      expect(timedOut.structuredContent).toMatchObject({ code: "TIMEOUT" });
      expect(limited.structuredContent).toMatchObject({ code: "LIMIT_EXCEEDED" });
      expect(JSON.stringify(limited)).not.toContain("xxxx");
    } finally {
      authed.close();
      await http.close();
    }
  });

  it("speaks newline-delimited stdio to an in-process client", async () => {
    const server = createMcpServer({
      tools: {
        echo: tool({
          name: "echo",
          schema: z.object({ text: z.string() }),
          execute: async ({ text }) => ({ text })
        })
      }
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const running = serveMcpStdio(server, { input, output });
    const queue: unknown[] = [];
    const pending: Array<(message: unknown) => void> = [];
    let buffered = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        if (!line) continue;
        const message = JSON.parse(line) as unknown;
        const waiter = pending.shift();
        if (waiter) waiter(message);
        else queue.push(message);
      }
    });
    const next = () => {
      const queued = queue.shift();
      return queued !== undefined ? Promise.resolve(queued) : new Promise<unknown>((resolve) => pending.push(resolve));
    };
    const request = async (method: string, params?: unknown) => {
      const id = method === "initialize" ? 1 : 2;
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      for (;;) {
        const message = await next() as { id?: number; result?: { tools?: unknown[]; protocolVersion?: string } };
        if (message.id === id) return message;
      }
    };
    try {
      const initialized = await request("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "stdio-test", version: "1" }
      });
      expect(initialized.result?.protocolVersion).toBe("2025-11-25");
      input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      const listed = await request("tools/list");
      expect(listed.result?.tools).toEqual([expect.objectContaining({ name: "echo" })]);
    } finally {
      input.end();
      await running.close();
    }
  });

  it("roundtrips a web-stream stdio session without a child process", async () => {
    const server = createMcpServer({
      tools: {
        ping: tool({
          name: "ping",
          schema: z.object({}),
          execute: () => ({ ok: true })
        })
      }
    });
    let inbound!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({ start(controller) { inbound = controller; } });
    const chunks: Uint8Array[] = [];
    let outbound!: ReadableStreamDefaultController<Uint8Array>;
    const output = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk);
        outbound.enqueue(chunk);
      }
    });
    const readable = new ReadableStream<Uint8Array>({ start(controller) { outbound = controller; } });
    const session = createMcpStdioServer({ server, input, output });
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const reader = readable.getReader();
    let buffered = "";
    const readMessage = async () => {
      while (!buffered.includes("\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("stdio closed");
        buffered += decoder.decode(chunk.value);
      }
      const newline = buffered.indexOf("\n");
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      return JSON.parse(line) as { id?: number; result?: { ok?: boolean; content?: Array<{ text: string }> } };
    };
    const send = (message: unknown) => { inbound.enqueue(encoder.encode(`${JSON.stringify(message)}\n`)); };
    try {
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "web", version: "1" } } });
      expect((await readMessage()).id).toBe(1);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ping", arguments: {} } });
      const called = await readMessage();
      expect(called.id).toBe(2);
      expect(called.result?.content?.[0]?.text).toContain("ok");
      expect(chunks.length).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });

  it("rejects hosted tools, duplicate names, and browser stdio", async () => {
    expect(() => createMcpServer({
      tools: { search: hostedTool({ name: "search", type: "web_search" }) }
    })).toThrow(McpServerError);
    expect(() => createMcpServer({
      tools: {
        echo: tool({ name: "echo", schema: z.object({}), execute: () => ({ ok: true }) })
      },
      agents: {
        echo: { agent: new Agent({ name: "echo", model: createMockLanguageModel() }) }
      }
    })).toThrow(/Duplicate MCP tool/);
    expect(() => browserStub.serveMcpStdio()).toThrow(browserStub.McpServerError);
    await expect(useHttp(createMcpServer(), (client) => client.listTools())).resolves.toMatchObject({ tools: [] });
    const nodeSource = await readFile(path.join(sourceRoot, "mcp-server-stdio.ts"), "utf8");
    const browserSource = await readFile(path.join(sourceRoot, "mcp-server-stdio-browser.ts"), "utf8");
    const root = await readFile(path.join(sourceRoot, "index.ts"), "utf8");
    expect(nodeSource).toContain('from "node:stream"');
    expect(browserSource).not.toContain("node:");
    expect(root).not.toContain("mcp-server");
    const directory = await mkdtemp(path.join(os.tmpdir(), "mcp-server-browser-"));
    try {
      const browserOut = path.join(directory, "browser.js");
      await execFileAsync("bun", ["build", path.join(sourceRoot, "mcp-server-stdio-browser.ts"), "--target=browser", `--outfile=${browserOut}`]);
      expect(await readFile(browserOut, "utf8")).not.toContain("node:stream");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unauthenticated HTTP clients through the shared client error", async () => {
    const http = createMcpHttpServer(createMcpServer(), {
      authenticate: () => { throw new McpServerError("AUTH_REQUIRED", "missing"); }
    });
    const client = createMcpHttpClient({
      url: "https://mcp.test/mcp",
      fetch: fetchHandler((request) => http.fetch(request))
    });
    await expect(client.listTools()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(McpHttpError).toBeTruthy();
    client.close();
    await http.close();
  });
});
