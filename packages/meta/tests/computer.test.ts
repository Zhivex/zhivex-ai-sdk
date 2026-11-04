import { describe, expect, it, vi } from "vitest";
import { createMeta, metaComputerTool, metaComputerCallOutput } from "../src/index.js";
const call = { type: "computer_call", id: "cc_1", call_id: "call_1", actions: [{ type: "click", x: 1, y: 2, button: "left" }], pending_safety_checks: [{ id: "check_1", code: "review", message: "Review" }], meta_safety_replay_receipt: "opaque", status: "completed" };
const screenshot = "data:image/png;base64,aGVsbG8=";
describe("Meta native computer protocol", () => {
  it("routes through Responses, preserves calls/checks/receipts, and replays stateless history", async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json({ id: "resp_1", output: [call] }));
    const model = createMeta({ apiKey: "test", fetch: fetcher })("muse-wonder-1.0");
    const tools = { computer: metaComputerTool() };
    const result = await model.generate({ messages: [{ role: "user", parts: [{ type: "text", text: "Look" }] }], tools, providerOptions: { store: false } });
    expect(fetcher.mock.calls[0][0]).toContain("/responses");
    expect(JSON.parse(fetcher.mock.calls[0][1].body).tools).toEqual([{ type: "computer" }]);
    expect(result.messages[0].parts[0]).toMatchObject({ type: "provider-data", provider: "meta", data: call });
    const output = metaComputerCallOutput({ callId: "call_1", imageUrl: screenshot });
    await model.generate({ messages: [...result.messages, { role: "user", parts: [output] }], tools, providerOptions: { store: false } });
    const body = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(body).not.toHaveProperty("previous_response_id");
    expect(body.input).toEqual([call, { type: "computer_call_output", call_id: "call_1", acknowledged_safety_checks: [], output: { type: "computer_screenshot", image_url: screenshot } }]);
  });
  it("streams native calls as provider-data with all safety fields", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(`data: ${JSON.stringify({ type: "response.output_item.done", item: call })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed" } })}\n\n`));
    const model = createMeta({ apiKey: "test", fetch: fetcher })("muse-spark-1.3");
    const events = [];
    for await (const event of await model.stream({ messages: [], tools: { computer: metaComputerTool() } })) events.push(event);
    expect(events).toContainEqual({ type: "provider-data", provider: "meta", data: call });
  });
  it("never auto-acknowledges checks and rejects URL screenshots", () => {
    expect(() => metaComputerCallOutput({ callId: "call_1", imageUrl: "https://example.com/image.png" })).toThrow();
    expect(metaComputerCallOutput({ callId: "call_1", imageUrl: screenshot, acknowledgedSafetyChecks: call.pending_safety_checks })).toMatchObject({ data: { acknowledged_safety_checks: call.pending_safety_checks } });
  });
});
