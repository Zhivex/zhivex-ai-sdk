import { describe, expect, it, vi } from "vitest";
import { createAnthropic, anthropicThreadCreate, anthropicThreadContinue } from "../src/index.js";
const messages = [{ role: "user" as const, parts: [{ type: "text" as const, text: "Hello" }] }];
const response = () => Response.json({ id: "msg_1", content: [{ type: "text", text: "Hi" }], stop_reason: "end_turn" });
describe("explicit Anthropic message threads", () => {
  it("creates only on opt-in and continues with no inherited system/tools", async () => {
    const fetcher = vi.fn().mockImplementation(async () => response());
    const model = createAnthropic({ apiKey: "test", fetch: fetcher })("claude-opus-5-5");
    await model.generate({ messages });
    expect(new Headers(fetcher.mock.calls[0][1].headers).get("anthropic-beta") ?? "").not.toContain("message-threads");
    await model.generate({ messages, providerOptions: { thread: anthropicThreadCreate() } });
    expect(new Headers(fetcher.mock.calls[1][1].headers).get("anthropic-beta")).toContain("message-threads-2026-08-12");
    await model.generate({ messages, providerOptions: { thread: anthropicThreadContinue("msg_1") } });
    const body = JSON.parse(fetcher.mock.calls[2][1].body);
    expect(body.thread).toEqual({ type: "continue", previous_message_id: "msg_1" });
    expect(body.messages).toHaveLength(1);
    expect(body).not.toHaveProperty("system"); expect(body).not.toHaveProperty("tools");
  });
  it("does not replay expired threads implicitly and rejects inherited fields", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ error: { type: "not_found_error", message: "expired" } }, { status: 404 }));
    const model = createAnthropic({ apiKey: "test", fetch: fetcher })("claude-opus-5-5");
    await expect(model.generate({ messages, providerOptions: { thread: anthropicThreadContinue("msg_1") } })).rejects.toMatchObject({ status: 404 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(model.generate({ messages, tools: {}, providerOptions: { thread: anthropicThreadContinue("msg_1") } })).rejects.toThrow("omit system and tools");
    expect(() => anthropicThreadContinue("")).toThrow();
  });
  it("adds the beta and continuation contract to streams", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('event: message_start\ndata: {"message":{"id":"msg_stream"}}\n\nevent: message_stop\ndata: {}\n\n', { headers: { "content-type": "text/event-stream" } }));
    const model = createAnthropic({ apiKey: "test", fetch: fetcher })("claude-opus-5-5");
    const events = [];
    for await (const event of await model.stream({ messages, providerOptions: { thread: anthropicThreadContinue("msg_1"), betas: ["other-beta"] } })) events.push(event);
    expect(events).toContainEqual({ type: "provider-data", provider: "anthropic", data: { type: "message-thread", messageId: "msg_stream" } });
    expect(new Headers(fetcher.mock.calls[0][1].headers).get("anthropic-beta")).toContain("message-threads-2026-08-12");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ stream: true, thread: { type: "continue" } });
  });
});
