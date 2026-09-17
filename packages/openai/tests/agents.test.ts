import { describe, expect, it, vi } from "vitest";
import { createOpenAI } from "../src/index.js";

const input = { agent: { model: "gpt-6-astra" }, environment: { type: "none" }, input: "Hello" };

describe("native OpenAI Agents API", () => {
  it("accepts empty HTTP 202 acknowledgements for messages and cancellation", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 202 }));
    const client = createOpenAI({ apiKey: "test", fetch: fetcher as typeof fetch }).agents;
    await expect(client.sendEvents("sess_123", [{ type: "agent.session.input.message", input: [] }])).resolves.toBeUndefined();
    fetcher.mockImplementationOnce(async () => new Response("", { status: 202, headers: { "content-length": "0" } }));
    await expect(client.cancelTurn("sess_123")).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("creates, retrieves, continues, cancels and deletes a session on the native route", async () => {
    const fetcher = vi.fn(async () => Response.json({ id: "sess_123" }));
    const client = createOpenAI({ apiKey: "test", fetch: fetcher as typeof fetch }).agents;
    expect(await client.createSession(input)).toEqual({ id: "sess_123" });
    await client.getSession("sess_123");
    await client.sendEvents("sess_123", [{ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text: "Continue" }] }] }]);
    await client.cancelTurn("sess_123");
    await client.listItems("sess_123", { after: "item & one", order: "asc" });
    await client.deleteSession("sess_123");
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url]) => url)).toEqual([
      "https://api.openai.com/v1/agents/sessions", "https://api.openai.com/v1/agents/sessions/sess_123",
      "https://api.openai.com/v1/agents/sessions/sess_123/events", "https://api.openai.com/v1/agents/sessions/sess_123/events",
      "https://api.openai.com/v1/agents/sessions/sess_123/items?after=item+%26+one&order=asc", "https://api.openai.com/v1/agents/sessions/sess_123"
    ]);
    expect(calls[0][1]).toMatchObject({ redirect: "error", headers: { "OpenAI-Beta": "agents=v1", authorization: "Bearer test" } });
    expect(JSON.parse(calls[3][1].body as string)).toEqual({ events: [{ type: "agent.session.input.cancel" }] });
    expect(() => client.getSession("../messages")).toThrow("session ID");
  });

  it("preserves idle, subagent completions and failures without claiming success", async () => {
    const events = [
      { type: "agent.session.idle" },
      { type: "agent.session.turn.completed", turn: { subagent_id: "child" } },
      { type: "agent.session.turn.failed", turn: { subagent_id: null, error: { message: "failed" } } }
    ];
    const fetcher = vi.fn(async () => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
    const client = createOpenAI({ apiKey: "test", fetch: fetcher as typeof fetch }).agents;
    const received = [];
    for await (const event of client.streamSession(input)) received.push(event);
    expect(received).toEqual(events);
  });

  it("does not retry mutations and propagates cancellation and malformed events", async () => {
    const fetcher = vi.fn(async () => new Response("unavailable", { status: 503 }));
    const client = createOpenAI({ apiKey: "test", fetch: fetcher as typeof fetch }).agents;
    await expect(client.createSession(input)).rejects.toMatchObject({ status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockImplementationOnce(async () => new Response("data: broken\n\n"));
    await expect(client.streamEvents("sess_123").next()).rejects.toThrow("event JSON");
    const abort = new AbortController();
    abort.abort(new Error("cancelled by caller"));
    await expect(client.createSession(input, { abortSignal: abort.signal })).rejects.toThrow("cancelled by caller");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("releases a streaming response when the consumer stops without cancelling remote work", async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"agent.session.idle"}\n\n')); },
      cancel
    })));
    const client = createOpenAI({ apiKey: "test", fetch: fetcher as typeof fetch }).agents;
    for await (const event of client.streamEvents("sess_123")) {
      expect(event.type).toBe("agent.session.idle");
      break;
    }
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
