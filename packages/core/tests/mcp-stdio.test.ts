import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createMcpToolRegistry } from "../src/mcp.js";
import { createMcpStdioClient, McpStdioError, type McpStdioClient } from "../src/mcp-stdio.js";
import * as browserStub from "../src/mcp-stdio-browser.js";
import { toToolSet } from "../src/tool-registry.js";

const execFileAsync = promisify(execFile);
const fixturePath = path.resolve(import.meta.dirname, "fixtures/mcp-stdio-server.mjs");
const sourceRoot = path.resolve(import.meta.dirname, "../src");
const clients: McpStdioClient[] = [];

const openClient = (
  mode: string,
  options: Partial<Parameters<typeof createMcpStdioClient>[0]> = {}
): McpStdioClient => {
  const env = {
    ...(options.env ?? { MCP_VISIBLE: "yes" }),
    MCP_FIXTURE_MODE: mode
  };
  const client = createMcpStdioClient({
    command: process.execPath,
    args: [fixturePath, "alpha beta"],
    timeoutMs: 2_000,
    shutdownGraceMs: 200,
    ...options,
    env
  });
  clients.push(client);
  return client;
};

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("MCP stdio client", () => {
  it("negotiates once, lists tools, calls a tool, and keeps stderr out of the protocol", async () => {
    const stderr: string[] = [];
    const client = openClient("ping", {
      onStderr: (chunk) => {
        stderr.push(chunk);
        if (stderr.length === 1) throw new Error("host sink failed");
      }
    });
    const listed = await client.listTools();
    const again = await client.listTools();
    expect(listed).toMatchObject({ tools: expect.arrayContaining([expect.objectContaining({ name: "get-bcra-fx-quotes" })]) });
    expect(again).toEqual(listed);
    expect(client.capabilities).toMatchObject({ tools: {} });
    const result = await client.callTool({ name: "get-bcra-fx-quotes", arguments: { fecha: "2026-01-02" } });
    expect(result).toMatchObject({
      content: [{ type: "text", text: JSON.stringify({ tool: "get-bcra-fx-quotes", arguments: { fecha: "2026-01-02" } }) }]
    });
    expect(client.stderr()).toContain("stderr-secret");
    expect(client.stderr()).toContain("pong");
    expect(stderr.join("")).toContain("pong");
    expect(JSON.stringify(result)).not.toContain("stderr-secret");
  });

  it("answers unsupported server requests and reads resources and prompts", async () => {
    const client = openClient("server-request");
    expect(await client.listResources!()).toMatchObject({ nextCursor: "next" });
    expect(client.stderr()).toContain("method-not-found");
    expect(await client.listResourceTemplates!()).toMatchObject({
      resourceTemplates: [{ uriTemplate: "bcra://variables/{id}", name: "variable" }]
    });
    expect(await client.readResource!({ uri: "bcra://variables" })).toMatchObject({
      contents: [{ text: "reservas" }]
    });
    expect(await client.listPrompts!()).toMatchObject({ prompts: [{ name: "summarize" }] });
    expect(await client.getPrompt!({ name: "summarize" })).toMatchObject({
      messages: [{ role: "user" }]
    });
  });

  it("rejects missing capabilities without treating stderr as a failure", async () => {
    const client = openClient("tools-only");
    await expect(client.listResources!()).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    expect(client.stderr()).toContain("stderr-secret");
    expect(await client.listTools()).toMatchObject({ tools: expect.any(Array) });
  });

  it("reassembles a split stdout frame and preserves argv without a shell", async () => {
    const client = openClient("split");
    const listed = await client.listTools();
    expect(listed).toMatchObject({ tools: [{ name: "split" }] });
    const described = openClient("ok");
    const tools = await described.listTools();
    const fx = (tools as { tools: Array<{ description?: string }> }).tools.find((tool) => tool.description?.startsWith("fx argv:"));
    expect(fx?.description).toBe("fx argv:alpha beta");
  });

  it("matches concurrent tool responses out of order", async () => {
    const client = openClient("reorder");
    const [first, second] = await Promise.all([
      client.callTool({ name: "first" }),
      client.callTool({ name: "second" })
    ]);
    expect(first).toMatchObject({ content: [{ text: "first" }] });
    expect(second).toMatchObject({ content: [{ text: "second" }] });
  });

  it("replaces the parent environment instead of inheriting it", async () => {
    const previous = process.env.MCP_PARENT_ONLY;
    process.env.MCP_PARENT_ONLY = "parent-secret";
    try {
      const client = openClient("ok", { env: { MCP_VISIBLE: "yes" } });
      const listed = await client.listTools() as { tools: Array<{ name: string; description?: string }> };
      const probe = listed.tools.find((tool) => tool.name === "env-probe");
      expect(probe?.description).toBe("parent:missing;visible:yes");
      expect(probe?.description).not.toContain("parent-secret");
    } finally {
      if (previous === undefined) delete process.env.MCP_PARENT_ONLY;
      else process.env.MCP_PARENT_ONLY = previous;
    }
  });

  it("bounds stdout and keeps a stderr tail", async () => {
    const oversizedRequest = openClient("ok", { maxMessageBytes: 32 });
    await expect(oversizedRequest.initialize()).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
      message: "MCP request exceeded byte limit."
    });
    const huge = openClient("huge", { maxMessageBytes: 1024 });
    await expect(huge.listTools()).rejects.toMatchObject({ code: "LIMIT_EXCEEDED", message: "MCP response exceeded byte limit." });
    const noisy = openClient("ok", { maxStderrBytes: 12 });
    await noisy.listTools();
    expect(noisy.stderr().length).toBeLessThanOrEqual(12);
  });

  it("fails closed on invalid frames without echoing the payload", async () => {
    await expect(openClient("bad-json").listTools()).rejects.toMatchObject({
      code: "PROTOCOL_ERROR",
      message: "Invalid MCP JSON response."
    });
    await expect(openClient("bad-utf8").listTools()).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    await expect(openClient("bad-version").initialize()).rejects.toMatchObject({
      code: "PROTOCOL_ERROR",
      message: "Unsupported MCP initialization result."
    });
    const rpc = openClient("rpc-error");
    await expect(rpc.listTools()).rejects.toMatchObject({
      code: "PROTOCOL_ERROR",
      message: "MCP server returned a JSON-RPC error."
    });
    await expect(rpc.listTools()).rejects.toThrow(McpStdioError);
    expect(String(await rpc.listTools().catch((error: unknown) => error))).not.toContain("secret-server-error");
  });

  it("reports process exit and indeterminate tool calls without stderr secrets", async () => {
    const missing = "/tmp/zhivex-missing-mcp-stdio-bin";
    const absent = createMcpStdioClient({ command: missing, timeoutMs: 1_000, shutdownGraceMs: 50 });
    clients.push(absent);
    await expect(absent.listTools()).rejects.toMatchObject({
      code: "PROCESS_EXITED",
      message: "MCP stdio process failed to start."
    });
    await expect(absent.listTools()).rejects.not.toThrow(expect.objectContaining({ message: expect.stringContaining(missing) }));

    const crashedList = openClient("crash-on-list");
    await expect(crashedList.listTools()).rejects.toMatchObject({ code: "PROCESS_EXITED" });
    expect(String(await crashedList.listTools().catch((error: unknown) => (error as Error).message))).not.toContain("stderr-secret");

    const crashedCall = openClient("crash-on-call");
    await expect(crashedCall.callTool({ name: "get-bcra-fx-quotes" })).rejects.toMatchObject({ code: "INDETERMINATE" });
    await expect(crashedCall.callTool({ name: "get-bcra-fx-quotes" })).rejects.not.toThrow(
      expect.objectContaining({ message: expect.stringContaining("crash-secret") })
    );

    const badShape = openClient("bad-tool-result");
    await expect(badShape.callTool({ name: "get-bcra-fx-quotes" })).rejects.toMatchObject({ code: "INDETERMINATE" });
  });

  it("times out, cancels in-flight tool calls, and closes the process group", async () => {
    const slow = openClient("slow", { timeoutMs: 50, shutdownGraceMs: 50 });
    await expect(slow.listTools()).rejects.toMatchObject({ name: "TimeoutError" });

    const controller = new AbortController();
    const cancellable = openClient("delay-call", { shutdownGraceMs: 50 });
    await cancellable.initialize();
    const pending = cancellable.callTool({ name: "get-bcra-fx-quotes" }, { abortSignal: controller.signal });
    setTimeout(() => controller.abort(new DOMException("caller cancelled", "AbortError")), 20);
    await expect(pending).rejects.toMatchObject({ code: "INDETERMINATE" });
    await expect.poll(() => cancellable.stderr()).toContain("cancelled:");

    const stubborn = openClient("ignore-shutdown", { shutdownGraceMs: 30 });
    await stubborn.initialize();
    await expect.poll(() => stubborn.stderr()).toMatch(/pid:\d+/);
    const pid = Number(stubborn.stderr().match(/pid:(\d+)/)?.[1]);
    expect(alive(pid)).toBe(true);
    await stubborn.close();
    await stubborn.close();
    expect(alive(pid)).toBe(false);

    const grouped = openClient("grandchild", { shutdownGraceMs: 30 });
    await grouped.initialize();
    await expect.poll(() => grouped.stderr()).toMatch(/grandchild:\d+/);
    const grandchild = Number(grouped.stderr().match(/grandchild:(\d+)/)?.[1]);
    expect(alive(grandchild)).toBe(true);
    await grouped.close();
    expect(alive(grandchild)).toBe(false);
  });

  it("validates options before spawning and stays closed", async () => {
    expect(() => createMcpStdioClient({ command: "" })).toThrow(McpStdioError);
    expect(() => createMcpStdioClient({ command: "node", args: ["ok\0"] })).toThrow(McpStdioError);
    expect(() => createMcpStdioClient({ command: "node", timeoutMs: 0 })).toThrow(McpStdioError);
    const client = openClient("ok");
    await client.close();
    await expect(client.listTools()).rejects.toMatchObject({ code: "PROCESS_EXITED" });
  });

  it("wires an allowlisted registry that omits debtor lookup tools", async () => {
    const client = openClient("ok");
    const registry = await createMcpToolRegistry(client, {
      includeTools: ["get-bcra-fx-quotes", "get-bcra-variables", "get-bcra-entities"]
    });
    const tools = toToolSet(registry);
    expect(Object.keys(tools ?? {}).sort()).toEqual([
      "get-bcra-entities",
      "get-bcra-fx-quotes",
      "get-bcra-variables"
    ]);
    const quotes = tools?.["get-bcra-fx-quotes"];
    expect(quotes?.execute).toBeTypeOf("function");
    const output = await quotes?.execute?.({ fecha: "2026-03-01" });
    expect(JSON.stringify(output)).toContain("get-bcra-fx-quotes");
    expect(JSON.stringify(output)).not.toContain("deudores");
  });

  it("keeps the transport out of browser-safe entrypoints", async () => {
    const nodeSource = await readFile(path.join(sourceRoot, "mcp-stdio.ts"), "utf8");
    const browserSource = await readFile(path.join(sourceRoot, "mcp-stdio-browser.ts"), "utf8");
    expect(nodeSource).toContain('from "node:child_process"');
    expect(browserSource).not.toContain("node:");
    for (const entry of ["index.ts", "ui-entry.ts", "experimental-entry.ts", "beta-entry.ts", "runtime-entry.ts", "node.ts"]) {
      const source = await readFile(path.join(sourceRoot, entry), "utf8");
      expect(source, entry).not.toContain("mcp-stdio");
    }
    expect(() => browserStub.createMcpStdioClient()).toThrow(browserStub.McpStdioError);
    const pkg = JSON.parse(await readFile(path.join(sourceRoot, "../package.json"), "utf8")) as {
      exports: Record<string, { browser?: string; node?: string; import?: string }>;
    };
    expect(pkg.exports["./mcp-stdio"]).toMatchObject({
      browser: "./dist/mcp-stdio-browser.js",
      node: "./dist/mcp-stdio.js",
      import: "./dist/mcp-stdio.js"
    });
    const directory = await mkdtemp(path.join(os.tmpdir(), "mcp-stdio-browser-"));
    try {
      const browserOut = path.join(directory, "browser.js");
      const nodeOut = path.join(directory, "node.js");
      await execFileAsync("bun", ["build", path.join(sourceRoot, "mcp-stdio-browser.ts"), "--target=browser", `--outfile=${browserOut}`]);
      await execFileAsync("bun", ["build", path.join(sourceRoot, "mcp-stdio.ts"), "--target=node", `--outfile=${nodeOut}`]);
      expect(await readFile(browserOut, "utf8")).not.toContain("child_process");
      expect(await readFile(nodeOut, "utf8")).toContain("child_process");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
