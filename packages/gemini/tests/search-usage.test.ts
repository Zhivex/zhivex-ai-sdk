import { expect, it, vi } from "vitest";
import { createTextMessage, googleSearchTool } from "@zhivex-ai/core";
import { createGemini } from "../src/index.js";
const messages = [createTextMessage("user", "Search")]; const tools = { search: googleSearchTool() };
const chunk = (queries?: unknown, finishReason?: string) => ({ responseId: "resp_1", candidates: [{ groundingMetadata: { webSearchQueries: queries }, finishReason }] });
const sse = (events: any[]) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
const run = async (events: any[], modelId = "gemini-3.8-flash") => {
  const model = createGemini({ apiKey: "fixture", fetch: async () => sse(events) })(modelId);
  const output: any[] = []; for await (const e of await model.stream({ messages, tools })) output.push(e);
  return output.filter(e => e.type === "provider-data" && e.data.type === "hosted-tool-usage").map(e => e.data);
};
it("counts exact unique nonempty queries without exposing them or summing snapshots", async () => {
  const partial = chunk(["PRIVATE QUERY", "", " ", "PRIVATE QUERY", "second"]);
  const final = chunk(["PRIVATE QUERY", "", " ", "PRIVATE QUERY", "second"], "STOP");
  const records = await run([partial, partial, final, final]);
  expect(records).toHaveLength(3);
  expect(records.map(r => r.quantity)).toEqual([undefined, 2, 2]);
  expect(records.map(r => r.completeness)).toEqual(["unknown", "partial", "complete"]);
  expect(new Set(records.map(r => r.attemptId)).size).toBe(1);
  expect(JSON.stringify(records)).not.toContain("PRIVATE QUERY");
});
it.each([[[], 0], [undefined, undefined], [[null], undefined], [Array(1025).fill("q"), undefined]])("distinguishes zero from absent/invalid/bounded metadata %j", async (queries, expected) => {
  const records = await run([chunk(queries, "STOP")]);
  expect(records.at(-1).quantity).toBe(expected);
  expect(records.at(-1).completeness).toBe(expected === undefined ? "unknown" : "complete");
});
it("does not claim complete usage when terminal queries are absent", async () => {
  expect((await run([chunk(["q"]), chunk(undefined, "STOP")])).at(-1)).toMatchObject({ quantity: 1, completeness: "partial", terminal: true });
});
it("uses grounded-prompt units for older models and unknown for unrecognized families", async () => {
  expect((await run([chunk(["a", "b"], "STOP")], "gemini-2.5-flash")).at(-1)).toMatchObject({ quantity: 1, unit: "grounded-prompt" });
  expect((await run([chunk([], "STOP")], "gemini-2.5-flash")).at(-1).quantity).toBeUndefined();
  expect((await run([chunk(["a"], "STOP")], "future-model")).at(-1)).toMatchObject({ unit: "unknown", completeness: "unknown" });
});
it("preserves metering in generate without using URL count", async () => {
  const model = createGemini({ apiKey: "fixture", fetch: async () => Response.json(chunk(["a", "a", "b"], "STOP")) })("gemini-3.8-flash");
  const result = await model.generate({ messages, tools });
  expect(result.messages[0].parts).toContainEqual(expect.objectContaining({ type: "provider-data", data: expect.objectContaining({ quantity: 2, terminal: true }) }));
});
it("keeps partial consumption after cancellation", async () => {
  const controller = new AbortController();
  const model = createGemini({ apiKey: "fixture", fetch: async () => sse([chunk(["q"]), chunk(["q"], "STOP")]) })("gemini-3.8-flash");
  const iterator = (await model.stream({ messages, tools, abortSignal: controller.signal }))[Symbol.asyncIterator]();
  await iterator.next(); expect((await iterator.next()).value).toMatchObject({ data: { quantity: 1, completeness: "partial" } });
  controller.abort(); await expect(iterator.next()).rejects.toThrow();
});
it("declares distinct unverified Interactions metering and rejects unverified limits on both routes", async () => {
  const fetch = vi.fn(); const provider = createGemini({ apiKey: "fixture", fetch }); const model = provider("gemini-3.8-flash");
  expect(model.capabilities.hostedTools).toContainEqual({ route: "interactions", tool: "google_search", limit: "unverified", metering: "unverified" });
  await expect(model.generate({ messages, tools, providerOptions: { max_tool_calls: 1 } })).rejects.toThrow("not verified");
  await expect(model.stream({ messages, tools, providerOptions: { max_tool_calls: 1 } })).rejects.toThrow("not verified");
  await expect(provider.interactions.create({ modelId: "gemini-3.8-flash", input: "Search", providerOptions: { max_tool_calls: 1 } })).rejects.toThrow("not verified");
  expect(fetch).not.toHaveBeenCalled();
});
