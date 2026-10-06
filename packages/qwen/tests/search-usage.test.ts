import { expect, it, vi } from "vitest";
import { createTextMessage, type HostedToolUsage, type StreamEvent } from "@zhivex-ai/core";
import { createQwen, qwenWebSearchTool } from "../src/index.js";
const messages = [createTextMessage("user", "search")];
const tools = { search: qwenWebSearchTool() };
const response = (count: unknown, id = "resp_1") => ({ id, status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 5, x_tools: { web_search: { count } } } });
const sse = (events: any[]) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
const records = (events: StreamEvent[]) => events.filter(e => e.type === "provider-data" && (e.data as any).type === "hosted-tool-usage").map(e => (e as any).data as HostedToolUsage);
it.each(["generate", "stream"] as const)("creates secure Responses attempt IDs without global Web Crypto (%s)", async method => {
  const raw = response(1);
  const model = createQwen({ apiKey: "fixture", fetch: async () => method === "stream"
    ? sse([{ type: "response.completed", response: raw }]) : Response.json(raw) })("qwen3.8-flash");
  vi.stubGlobal("crypto", undefined);
  try {
    let attemptId: string | undefined;
    if (method === "stream") {
      const events: StreamEvent[] = []; for await (const event of await model.stream({ messages, tools })) events.push(event);
      const usage = records(events);
      expect(usage[0].attemptId).toBe(usage[1].attemptId);
      attemptId = usage[0].attemptId;
    } else {
      const result = await model.generate({ messages, tools });
      const usage = result.messages[0].parts.find(part => part.type === "provider-data" && (part.data as HostedToolUsage).type === "hosted-tool-usage");
      if (usage?.type === "provider-data") attemptId = (usage.data as HostedToolUsage).attemptId;
    }
    expect(attemptId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally { vi.unstubAllGlobals(); }
});
it.each([0, 1, 7, undefined, -1, 0.5, "2", null])("preserves count %j without deriving it from citations in generate/stream", async count => {
  const raw = response(count);
  const model = createQwen({ apiKey: "fixture", fetch: async (_url, init) => JSON.parse(String(init?.body)).stream ? sse([{ type: "response.completed", response: raw }, { type: "response.completed", response: raw }]) : Response.json(raw) })("qwen3.8-flash");
  const result = await model.generate({ messages, tools });
  const generated = result.messages[0].parts.find(p => p.type === "provider-data" && (p.data as any).type === "hosted-tool-usage") as any;
  const events: StreamEvent[] = []; for await (const e of await model.stream({ messages, tools })) events.push(e);
  const metering = records(events);
  expect(metering).toHaveLength(2); // unknown start + single terminal snapshot
  const valid = typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
  for (const record of [generated.data, metering[1]]) {
    expect(record).toMatchObject({ responseId: "resp_1", unit: "call", completeness: valid ? "complete" : "unknown", terminal: true, audience: "internal" });
    expect(record.quantity).toBe(valid ? count : undefined);
  }
  expect(metering[0].attemptId).toBe(metering[1].attemptId);
  expect(generated.data.attemptId).not.toBe(metering[1].attemptId);
});
it("does not mistake cancellation for zero usage", async () => {
  const controller = new AbortController();
  const model = createQwen({ apiKey: "fixture", fetch: async () => sse([{ type: "response.completed", response: response(2) }]) })("qwen3.8-flash");
  const stream = (await model.stream({ messages, tools, abortSignal: controller.signal }))[Symbol.asyncIterator]();
  const first = await stream.next(); expect(first.value).toMatchObject({ data: { completeness: "unknown", terminal: false } });
  controller.abort(); await expect(stream.next()).rejects.toThrow();
});
it("reports unverified limits and rejects max_tool_calls before network I/O", async () => {
  const fetch = vi.fn(); const model = createQwen({ apiKey: "fixture", fetch })("qwen3.8-flash");
  expect(model.capabilities.hostedTools).toContainEqual({ route: "responses", tool: "web_search", limit: "unverified", metering: "provider-counter" });
  for (const method of ["generate", "stream"] as const) await expect(model[method]({ messages, tools, providerOptions: { max_tool_calls: 1 } })).rejects.toThrow("not verified");
  expect(fetch).not.toHaveBeenCalled();
});
it("does not replay metering as API input", async () => {
  const bodies: any[] = []; const model = createQwen({ apiKey: "fixture", fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return Response.json({ ...response(0), id: undefined }); } })("qwen3.8-flash");
  const result = await model.generate({ messages, tools });
  await model.generate({ messages: [...messages, ...result.messages, ...messages] });
  expect(bodies[1].input.some((i: any) => i.type === "hosted-tool-usage")).toBe(false);
});
