import { describe, expect, it, vi } from "vitest";
import { createAnthropic } from "../src/index.js";

describe("Anthropic managed agents", () => {
  it("uses current credentials, native routes and explicit permission policies", async () => {
    const fetcher = vi.fn(async () => Response.json({ id: "agent_123" }));
    const apiKey = vi.fn(async () => "test-current");
    const client = createAnthropic({ apiKey, fetch: fetcher as typeof fetch }).managedAgents;
    await client.agents.create({ name: "Assistant", model: "claude-opus-5", system: "Help", tools: [{ type: "agent_toolset_20260401", default_config: { permission_policy: { type: "auto" } } }] });
    await client.sessions.create({ agent: "agent_123", environment_id: "env_123" });
    await client.sessions.events.send("sess_123", { events: [{ type: "user.message", content: [{ type: "text", text: "Hello" }] }] });
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url]) => url)).toEqual([
      "https://api.anthropic.com/v1/agents?beta=true", "https://api.anthropic.com/v1/sessions?beta=true", "https://api.anthropic.com/v1/sessions/sess_123/events?beta=true"
    ]);
    expect(new Headers(calls[0][1].headers).get("x-api-key")).toBe("test-current");
    expect(new Headers(calls[0][1].headers).get("anthropic-beta")).toContain("managed-agents-2026-04-01");
    expect(calls[0][1].redirect).toBe("error");
    expect(JSON.parse(calls[0][1].body as string).tools[0].default_config.permission_policy).toEqual({ type: "auto" });
    expect(apiKey).toHaveBeenCalledTimes(3);
  });

  it("preserves server permission evaluation events and does not retry failed mutations", async () => {
    const event = { type: "agent.tool_use", id: "sevt_1", name: "bash", input: { command: "test" }, evaluated_permission: "deny", evaluation: { type: "auto", evaluated_permission: { type: "deny", reason_code: "high_risk" } } };
    const fetcher = vi.fn(async () => new Response(`event: agent.tool_use\ndata: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    const client = createAnthropic({ apiKey: "test", fetch: fetcher as typeof fetch }).managedAgents;
    const received = [];
    for await (const value of await client.sessions.events.stream("sess_123")) received.push(value);
    expect(received).toEqual([event]);
    fetcher.mockImplementationOnce(async () => new Response("unavailable", { status: 503 }));
    await expect(client.sessions.create({ agent: "agent_123", environment_id: "env_123" })).rejects.toMatchObject({ status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("refreshes expired bearer credentials and retains a custom endpoint prefix", async () => {
    const credentials = vi.fn()
      .mockResolvedValueOnce({ token: "old-token", expiresAt: null })
      .mockResolvedValueOnce({ token: "new-token", expiresAt: null });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(Response.json({ id: "sess_123" }));
    const client = createAnthropic({ credentials, apiKey: null, authToken: null, baseURL: "https://example.com/proxy/v1", fetch: fetcher }).managedAgents;
    await client.sessions.retrieve("sess_123");
    const calls = fetcher.mock.calls as [string, RequestInit][];
    expect(calls.map(([url]) => url)).toEqual([
      "https://example.com/proxy/v1/sessions/sess_123?beta=true",
      "https://example.com/proxy/v1/sessions/sess_123?beta=true"
    ]);
    expect(new Headers(calls[0][1].headers).get("authorization")).toBe("Bearer old-token");
    expect(new Headers(calls[1][1].headers).get("authorization")).toBe("Bearer new-token");
    expect(new Headers(calls[1][1].headers).has("x-api-key")).toBe(false);
    expect(credentials).toHaveBeenCalledTimes(2);
  });
});
