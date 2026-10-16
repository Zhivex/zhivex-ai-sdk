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

  it("returns TOOL_FAILED when execute throws synchronously", async () => {
    const server = createMcpServer({
      tools: {
        boom: tool({
          name: "boom",
          schema: z.object({}),
          execute: () => {
            throw new Error("secret boom");
          }
        })
      }
    });
    const result = await useHttp(server, (client) => client.callTool({ name: "boom", arguments: {} }));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "TOOL_FAILED" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("bounds isEnabled and output guardrails with the call deadline", async () => {
    const server = createMcpServer({
      timeoutMs: 30,
      tools: {
        gate: tool({
          name: "gate",
          schema: z.object({}),
          isEnabled: () => new Promise<boolean>(() => undefined),
          execute: () => ({ ok: true })
        }),
        checked: tool({
          name: "checked",
          schema: z.object({}),
          execute: () => ({ ok: true }),
          outputGuardrails: [() => new Promise<void>(() => undefined)]
        }),
        screened: tool({
          name: "screened",
          schema: z.object({}),
          inputGuardrails: [() => new Promise<void>(() => undefined)],
          execute: () => ({ ok: true })
        })
      }
    });
    const result = await useHttp(server, async (client) => ({
      gate: await client.callTool({ name: "gate", arguments: {} }),
      screened: await client.callTool({ name: "screened", arguments: {} }),
      checked: await client.callTool({ name: "checked", arguments: {} })
    }));
    expect(result.gate.structuredContent).toMatchObject({ code: "TIMEOUT" });
    expect(result.screened.structuredContent).toMatchObject({ code: "TIMEOUT" });
    expect(result.checked.structuredContent).toMatchObject({ code: "TIMEOUT" });
    expect(JSON.stringify(result.checked)).not.toContain("\"ok\":true");
  });

  it("aborts an in-flight HTTP tool call when the server closes", async () => {
    let sawAbort = false;
    let started = false;
    const server = createMcpServer({
      timeoutMs: 30_000,
      tools: {
        hang: tool({
          name: "hang",
          schema: z.object({}),
          execute: (_input, context) => new Promise(() => {
            started = true;
            context?.abortSignal?.addEventListener("abort", () => {
              sawAbort = true;
            });
          })
        })
      }
    });
    const http = createMcpHttpServer(server);
    const client = createMcpHttpClient({
      url: "https://mcp.test/mcp",
      fetch: fetchHandler((request) => http.fetch(request))
    });
    const pending = client.callTool({ name: "hang", arguments: {} });
    const startedAt = Date.now();
    while (!started && Date.now() - startedAt < 1_000) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(started).toBe(true);
    await http.close();
    const result = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("close did not finish the call")), 500))
    ]);
    expect(sawAbort).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "CANCELLED" });
    client.close();
  });

  it("cancels numeric and string JSON-RPC ids independently", async () => {
    const aborted: string[] = [];
    let started = 0;
    const hang = (name: string) => tool({
      name,
      schema: z.object({}),
      execute: (_input, context) => new Promise(() => {
        started += 1;
        context?.abortSignal?.addEventListener("abort", () => {
          aborted.push(name);
        });
      })
    });
    const server = createMcpServer({
      timeoutMs: 5_000,
      tools: { left: hang("left"), right: hang("right") }
    });
    let inbound!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({ start(controller) { inbound = controller; } });
    const chunks: Uint8Array[] = [];
    const output = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk);
      }
    });
    const session = createMcpStdioServer({ server, input, output });
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const send = (message: unknown) => {
      inbound.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
    };
    const readLine = async () => {
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline) {
        const buffered = decoder.decode(Buffer.concat(chunks));
        const newline = buffered.indexOf("\n");
        if (newline !== -1) {
          chunks.length = 0;
          const rest = encoder.encode(buffered.slice(newline + 1));
          if (rest.byteLength > 0) chunks.push(rest);
          return JSON.parse(buffered.slice(0, newline)) as { id?: number | string; error?: { code?: number } };
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("timed out waiting for stdio");
    };
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "id-test", version: "1" } }
      });
      await readLine();
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "left", arguments: {} } });
      send({ jsonrpc: "2.0", id: "1", method: "tools/call", params: { name: "right", arguments: {} } });
      const startedAt = Date.now();
      while (started < 2 && Date.now() - startedAt < 1_000) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(started).toBe(2);
      send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
      const leftAt = Date.now();
      while (!aborted.includes("left") && Date.now() - leftAt < 1_000) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(aborted).toEqual(["left"]);
      send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "1" } });
      const rightAt = Date.now();
      while (!aborted.includes("right") && Date.now() - rightAt < 1_000) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(aborted).toEqual(["left", "right"]);
    } finally {
      inbound.close();
      await session.close();
    }
  });

  it("replaces an oversized stdio response with a bounded JSON-RPC error", async () => {
    const server = createMcpServer({
      tools: {
        wide: tool({
          name: "wide",
          description: "x".repeat(2_000),
          schema: z.object({}),
          execute: () => ({ ok: true })
        })
      }
    });
    let inbound!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({ start(controller) { inbound = controller; } });
    const chunks: Uint8Array[] = [];
    const output = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk);
      }
    });
    const session = createMcpStdioServer({ server, input, output, maxMessageBytes: 512 });
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const send = (message: unknown) => {
      inbound.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
    };
    const readLine = async () => {
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline) {
        const buffered = decoder.decode(Buffer.concat(chunks));
        const newline = buffered.indexOf("\n");
        if (newline !== -1) {
          chunks.length = 0;
          const rest = encoder.encode(buffered.slice(newline + 1));
          if (rest.byteLength > 0) chunks.push(rest);
          return buffered.slice(0, newline);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("timed out waiting for stdio");
    };
    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "limit-test", version: "1" } }
      });
      const initialized = await readLine();
      expect(initialized).toContain("2025-11-25");
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const listed = await readLine();
      expect(listed).not.toContain("x".repeat(20));
      expect(JSON.parse(listed)).toMatchObject({
        id: 2,
        error: { code: -32603, message: "MCP message exceeded byte limit." }
      });
    } finally {
      inbound.close();
      await session.close();
    }
  });

  it("returns before a stuck agent event stream and hides mapper failures", async () => {
    const model = createMockLanguageModel();
    model.stream = () => Promise.resolve((async function* () {
      await new Promise(() => undefined);
    })());
    const server = createMcpServer({
      timeoutMs: 30,
      agents: {
        stuck: {
          agent: new Agent({ name: "stuck", model })
        },
        mapper: {
          agent: new Agent({
            name: "mapper",
            model: createMockLanguageModel({
              streamEvents: [[{ type: "text-delta", textDelta: "nope" }, { type: "finish", finishReason: "stop" }]]
            })
          }),
          toRunInput: () => {
            throw new Error("secret mapper");
          }
        }
      }
    });
    const result = await Promise.race([
      useHttp(server, async (client) => ({
        stuck: await client.callTool({ name: "stuck", arguments: { prompt: "go" } }),
        mapper: await client.callTool({ name: "mapper", arguments: { prompt: "go" } })
      })),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("agent call was not bounded")), 1_000))
    ]);
    expect(result.stuck.structuredContent).toMatchObject({ code: "TIMEOUT" });
    expect(result.mapper.isError).toBe(true);
    expect(result.mapper.structuredContent).toMatchObject({ code: "AGENT_FAILED" });
    expect(JSON.stringify(result.mapper)).not.toContain("secret");
  });

  it("keeps HTTP responses inside maxResponseBytes, including the fallback error", async () => {
    const server = createMcpServer({
      tools: {
        wide: tool({
          name: "wide",
          schema: z.object({}),
          execute: () => ({ value: "x".repeat(2_000) })
        })
      }
    });
    const tiny = createMcpHttpServer(server, { maxResponseBytes: 8 });
    const initialize = await tiny.fetch(new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "limit", version: "1" } }
      })
    }));
    const tinyBody = await initialize.text();
    expect(new TextEncoder().encode(tinyBody).byteLength).toBeLessThanOrEqual(8);
    await tiny.close();

    const http = createMcpHttpServer(createMcpServer({
      tools: {
        wide: tool({
          name: "wide",
          schema: z.object({}),
          execute: () => ({ value: "x".repeat(2_000) })
        })
      }
    }), { maxResponseBytes: 400 });
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    const initialized = await http.fetch(new Request("https://mcp.test/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "limit", version: "1" } }
      })
    }));
    const session = initialized.headers.get("mcp-session-id");
    expect(session).toBeTruthy();
    await initialized.text();
    const accepted = await http.fetch(new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: { ...headers, "Mcp-Session-Id": session ?? "" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
    }));
    expect(accepted.status).toBe(202);
    const streamed = await http.fetch(new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: { ...headers, "Mcp-Session-Id": session ?? "" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "wide", arguments: {}, _meta: { progressToken: 1 } }
      })
    }));
    const body = await streamed.text();
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(400);
    expect(body).not.toContain("x".repeat(20));
    expect(body).toContain("MCP response exceeded byte limit.");
    await http.close();
  });

  it("times out a hanging auth hook and a body that never ends", async () => {
    const http = createMcpHttpServer(createMcpServer({ timeoutMs: 30 }), {
      authenticate: () => new Promise(() => undefined)
    });
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    const stalledAuth = await Promise.race([
      http.fetch(new Request("https://mcp.test/mcp", { method: "POST", headers, body: "{}" })),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("auth was not bounded")), 500))
    ]);
    expect(stalledAuth.status).toBe(408);
    await http.close();

    const open = createMcpHttpServer(createMcpServer({ timeoutMs: 30 }));
    const body = new ReadableStream<Uint8Array>({ start() { /* never closes */ } });
    const stalledBody = await Promise.race([
      open.fetch(new Request("https://mcp.test/mcp", { method: "POST", headers, body, duplex: "half" })),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("body read was not bounded")), 500))
    ]);
    expect(stalledBody.status).toBe(408);
    await open.close();
  });

  it("closes stdio when an unterminated line exceeds the message cap", async () => {
    const input = new TransformStream<Uint8Array, Uint8Array>();
    const output = new TransformStream<Uint8Array, Uint8Array>();
    const session = createMcpStdioServer({
      server: createMcpServer(),
      input: input.readable,
      output: output.writable,
      maxMessageBytes: 32
    });
    const reader = output.readable.getReader();
    const writer = input.writable.getWriter();
    await writer.write(new TextEncoder().encode("x".repeat(64)));
    let done = false;
    const deadline = Date.now() + 500;
    while (!done && Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 20))
      ]);
      if (!next) continue;
      done = next.done;
    }
    expect(done).toBe(true);
    await session.close();
  });

  it("rejects a browser Origin unless it is allowlisted", async () => {
    let authenticated = false;
    const open = createMcpHttpServer(createMcpServer(), {
      authenticate: () => {
        authenticated = true;
      }
    });
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    const browser = await open.fetch(new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: { ...headers, Origin: "https://evil.example" },
      body: "{}"
    }));
    expect(browser.status).toBe(403);
    expect(authenticated).toBe(false);
    const local = await open.fetch(new Request("https://mcp.test/mcp", {
      method: "POST",
      headers,
      body: "{}"
    }));
    expect(local.status).not.toBe(403);
    await open.close();

    const listed = createMcpHttpServer(createMcpServer(), {
      allowedOrigins: ["https://app.example"]
    });
    const missing = await listed.fetch(new Request("https://mcp.test/mcp", {
      method: "POST",
      headers,
      body: "{}"
    }));
    const foreign = await listed.fetch(new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: { ...headers, Origin: "https://evil.example" },
      body: "{}"
    }));
    const allowed = await listed.fetch(new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: { ...headers, Origin: "https://app.example" },
      body: "{}"
    }));
    expect(missing.status).toBe(403);
    expect(foreign.status).toBe(403);
    expect(allowed.status).not.toBe(403);
    await listed.close();
  });

  it("drops the oldest idle HTTP session and refuses initialize when every session is busy", async () => {
    let started = false;
    const hanging = createMcpServer({
      timeoutMs: 30_000,
      tools: {
        hang: tool({
          name: "hang",
          schema: z.object({}),
          execute: () => new Promise(() => {
            started = true;
          })
        })
      }
    });
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    const initialize = (id: number) => JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "sessions", version: "1" } }
    });
    const post = (http: ReturnType<typeof createMcpHttpServer>, body: string, session?: string) =>
      http.fetch(new Request("https://mcp.test/mcp", {
        method: "POST",
        headers: session ? { ...headers, "Mcp-Session-Id": session } : headers,
        body
      }));

    let nextId = 0;
    const capped = createMcpHttpServer(createMcpServer(), {
      maxSessions: 1,
      sessionId: () => `s${++nextId}`
    });
    const first = await post(capped, initialize(1));
    expect(first.headers.get("mcp-session-id")).toBe("s1");
    await first.text();
    const second = await post(capped, initialize(2));
    expect(second.headers.get("mcp-session-id")).toBe("s2");
    await second.text();
    const stale = await post(capped, JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }), "s1");
    const live = await post(capped, JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" }), "s2");
    expect(stale.status).toBe(404);
    expect(live.status).toBe(200);
    await capped.close();

    const busy = createMcpHttpServer(hanging, { maxSessions: 1, sessionId: () => "only" });
    const opened = await post(busy, initialize(1));
    expect(opened.headers.get("mcp-session-id")).toBe("only");
    await opened.text();
    const accepted = await post(busy, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), "only");
    expect(accepted.status).toBe(202);
    const call = post(busy, JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "hang", arguments: {} }
    }), "only");
    const startedAt = Date.now();
    while (!started && Date.now() - startedAt < 1_000) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(started).toBe(true);
    const blocked = await post(busy, initialize(6));
    expect(blocked.status).toBe(503);
    const stillThere = await post(busy, JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }), "only");
    expect(stillThere.status).toBe(200);
    await busy.close();
    await call.catch(() => undefined);
  });

  it("rejects timeout values Node would schedule as one millisecond", () => {
    expect(() => createMcpServer({ timeoutMs: 3_000_000_000 })).toThrow(/MCP timeout exceeds the timer range/);
    expect(() => createMcpHttpServer(createMcpServer(), { timeoutMs: 3_000_000_000 })).toThrow(/MCP timeout exceeds the timer range/);
    const server = createMcpServer({ timeoutMs: 2_147_483_647, maxResultBytes: 3_000_000_000 });
    const http = createMcpHttpServer(server, {
      maxRequestBytes: 3_000_000_000,
      maxResponseBytes: 3_000_000_000,
      maxSessions: 3_000_000_000
    });
    server.close();
    return http.close();
  });

  it("returns 503 when the server closes during authentication", async () => {
    let entered = false;
    const http = createMcpHttpServer(createMcpServer({ timeoutMs: 30_000 }), {
      authenticate: () => new Promise(() => {
        entered = true;
      })
    });
    const pending = http.fetch(new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: "{}"
    }));
    const startedAt = Date.now();
    while (!entered && Date.now() - startedAt < 1_000) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(entered).toBe(true);
    await http.close();
    const response = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("close did not finish authentication")), 500))
    ]);
    expect(response.status).toBe(503);
  });

  it("closes stdio and aborts the in-flight call when stdin reaches EOF", async () => {
    let started = false;
    let sawAbort = false;
    const server = createMcpServer({
      timeoutMs: 30_000,
      tools: {
        hang: tool({
          name: "hang",
          schema: z.object({}),
          execute: (_input, context) => new Promise(() => {
            started = true;
            context?.abortSignal?.addEventListener("abort", () => {
              sawAbort = true;
            });
          })
        })
      }
    });
    const input = new TransformStream<Uint8Array, Uint8Array>();
    const output = new TransformStream<Uint8Array, Uint8Array>();
    const session = createMcpStdioServer({ server, input: input.readable, output: output.writable });
    const writer = input.writable.getWriter();
    const reader = output.readable.getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let buffered = "";
    const send = async (message: unknown) => {
      await writer.write(encoder.encode(`${JSON.stringify(message)}\n`));
    };
    const readLine = async () => {
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline) {
        const newline = buffered.indexOf("\n");
        if (newline !== -1) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          return line;
        }
        const next = await Promise.race([
          reader.read(),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 20))
        ]);
        if (next && !next.done) buffered += decoder.decode(next.value);
      }
      throw new Error("timed out waiting for stdio");
    };
    await send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "eof", version: "1" } }
    });
    expect(await readLine()).toContain("2025-11-25");
    await send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "hang", arguments: {} } });
    const startedAt = Date.now();
    while (!started && Date.now() - startedAt < 1_000) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(started).toBe(true);
    await writer.close();
    let done = false;
    const deadline = Date.now() + 500;
    while (!done && Date.now() < deadline) {
      const newline = buffered.indexOf("\n");
      if (newline !== -1) {
        buffered = buffered.slice(buffered.indexOf("\n") + 1);
        continue;
      }
      const next = await Promise.race([
        reader.read(),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 20))
      ]);
      if (!next) continue;
      if (!next.done) buffered += decoder.decode(next.value);
      done = next.done;
    }
    expect(sawAbort).toBe(true);
    expect(done).toBe(true);
    await session.close();
  });
});
