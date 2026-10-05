import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpHttpClient } from "../src/mcp-http.js";
import { checkMcpDestination, readMcpBody, readMcpJson, withMcpAbort } from "../src/mcp-http-common.js";

afterEach(() => vi.useRealTimers());

describe("MCP trust boundaries and bounded transport", () => {
  it("bounds body bytes before decoding and cancels oversized remote responses", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(5)); }, cancel
    }));
    await expect(readMcpBody(response, 4)).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body!.locked).toBe(false);
  });

  it("sanitizes invalid JSON/UTF8 and preserves byte-limit diagnostics", async () => {
    await expect(readMcpJson(new Response("remote-secret invalid-json"), 100)).rejects.toMatchObject({
      code: "PROTOCOL_ERROR", message: "Invalid MCP JSON response."
    });
    await expect(readMcpJson(new Response(new Uint8Array([255])), 100)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    await expect(readMcpJson(new Response("oversized"), 1)).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await expect(readMcpBody(new Response(null), 10)).resolves.toBe("");
    await expect(readMcpJson(new Response('{"ok":true}'), 100)).resolves.toEqual({ ok: true });
  });

  it("enforces deadlines even when custom transport does not settle after abort", async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    const operation = withMcpAbort(current => { signal = current; return new Promise(() => {}); }, [], 10);
    const rejected = expect(operation).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates caller cancellation and removes listeners on success or abort", async () => {
    const parent = new AbortController();
    const remove = vi.spyOn(parent.signal, "removeEventListener");
    await expect(withMcpAbort(async () => "ok", [undefined, parent.signal])).resolves.toBe("ok");
    expect(remove).toHaveBeenCalledTimes(1);
    const operation = withMcpAbort(() => new Promise(() => {}), [parent.signal]);
    const reason = new Error("caller cancelled");
    const rejected = expect(operation).rejects.toBe(reason);
    parent.abort(reason);
    await rejected;
    expect(remove).toHaveBeenCalledTimes(2);
    const execute = vi.fn(async () => "never");
    await expect(withMcpAbort(execute, [parent.signal])).rejects.toBe(reason);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects unsafe URLs and prevents a policy callback from rewriting the checked destination", async () => {
    for (const url of ["http://mcp.example", "https://user:secret@mcp.example", "https://mcp.example/#private"]) {
      await expect(checkMcpDestination(url, "server")).rejects.toMatchObject({ code: "DESTINATION_REJECTED" });
    }
    const approved = await checkMcpDestination("https://mcp.example/mcp", "server", url => { url.hostname = "other.example"; return true; });
    expect(approved.href).toBe("https://mcp.example/mcp");
  });

  it("validates resource templates and prompts, isolates advertised capabilities and rejects calls after close", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      requests.push(request);
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result = request.method === "initialize"
        ? { protocolVersion: "2025-11-25", capabilities: { resources: {}, prompts: {} } }
        : request.method === "resources/templates/list"
          ? { resourceTemplates: [{ name: "document", uriTemplate: "file:///{id}", mimeType: "text/plain" }] }
          : request.method === "prompts/list"
            ? { prompts: [{ name: "summarize", arguments: [{ name: "input", required: true }] }] }
            : { description: "summary", messages: [{ role: "user", content: { type: "text", text: "Summarize this." } }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { headers: { "Content-Type": "application/json" } });
    });
    const client = createMcpHttpClient({ url: "https://mcp.example/mcp", fetch: fetcher as typeof fetch });
    expect(await client.listResourceTemplates!()).toEqual({ resourceTemplates: [{ name: "document", uriTemplate: "file:///{id}", mimeType: "text/plain" }] });
    expect(await client.listPrompts!()).toMatchObject({ prompts: [{ name: "summarize", arguments: [{ name: "input", required: true }] }] });
    expect(await client.getPrompt!({ name: "summarize", arguments: { input: "a" } })).toMatchObject({ messages: [{ role: "user" }] });
    const capabilities = client.capabilities!;
    delete capabilities.resources;
    expect(client.capabilities!.resources).toEqual({});
    expect(requests.filter(request => request.method === "initialize")).toHaveLength(1);
    client.close();
    const count = fetcher.mock.calls.length;
    await expect(client.listPrompts!()).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(count);
    expect(client.capabilities).toBeUndefined();
  });
});
