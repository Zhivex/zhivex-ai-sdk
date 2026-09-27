import { expect, it } from "vitest";
import { createTextMessage, googleSearchTool, type StreamEvent } from "@zhivex-ai/core";
import { createGemini } from "../src/index.js";
const messages = [createTextMessage("user", "Search")];
const groundingMetadata = {
  groundingChunks: [{ web: { uri: "https://example.com", title: "Source", private: "SECRET" } }],
  groundingSupports: [{ segment: { startIndex: 0, endIndex: 5, text: "Hello" }, groundingChunkIndices: [0] }],
  webSearchQueries: ["query"], searchEntryPoint: { renderedContent: "<div>Google attribution</div>" }, private: "SECRET"
};
const chunk = (metadata?: unknown, finishReason?: string) => ({ candidates: [{ index: 0, groundingMetadata: metadata, finishReason }] });
const sse = (events: unknown[]) => {
  const bytes = new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
  return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); } }));
};
const modelFor = (events: unknown[]) => createGemini({ apiKey: "fixture", fetch: async (_url, init) => {
  expect(JSON.parse(String(init?.body)).tools).toEqual([{ googleSearch: {} }]);
  return sse(events);
} })("gemini-3.8-flash");
const input = { messages, tools: { search: googleSearchTool() } };
const collect = async (events: unknown[]) => { const result: StreamEvent[] = []; for await (const event of await modelFor(events).stream(input)) if (!(event.type === "provider-data" && (event.data as any)?.type === "hosted-tool-usage")) result.push(event); return result; };
it("preserves terminal grounding on fragmented SSE before finish with required attribution", async () => {
  const events = await collect([chunk(groundingMetadata, "STOP")]);
  expect(events[0]).toMatchObject({ type: "provider-data", provider: "gemini", data: { type: "grounding-metadata", candidateIndex: 0, groundingMetadata: { groundingChunks: [{ web: { uri: "https://example.com", title: "Source" } }], groundingSupports: groundingMetadata.groundingSupports, searchEntryPoint: groundingMetadata.searchEntryPoint } } });
  expect(JSON.stringify(events)).not.toContain("SECRET");
  expect(events[1]).toMatchObject({ type: "finish", finishReason: "stop" });
});
it("deduplicates snapshots and merges fields delivered in separate chunks without shifting indices", async () => {
  const first = { groundingChunks: [{ invalid: true }, ...groundingMetadata.groundingChunks] };
  const second = { groundingSupports: [{ segment: { endIndex: 5 }, groundingChunkIndices: [1] }] };
  const events = await collect([chunk(first), chunk(first), chunk(second), chunk(second, "STOP")]);
  expect(events.filter(e => e.type === "provider-data")).toHaveLength(2);
  expect(events[1]).toMatchObject({ data: { groundingMetadata: { groundingChunks: [{}, { web: { uri: "https://example.com" } }], groundingSupports: second.groundingSupports } } });
});
it("handles missing and malformed metadata without inventing sources", async () => {
  expect(await collect([chunk(null), chunk({ groundingChunks: "bad" }, "STOP")])).toEqual([expect.objectContaining({ type: "finish" })]);
});
it("cancels without emitting later sources", async () => {
  const controller = new AbortController();
  const iterator = (await modelFor([chunk(groundingMetadata), chunk(groundingMetadata, "STOP")]).stream({ ...input, abortSignal: controller.signal }))[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toMatchObject({ type: "provider-data" });
  controller.abort(); await expect(iterator.next()).rejects.toThrow();
});
it("propagates transport errors", async () => {
  const model = createGemini({ apiKey: "fixture", fetch: async () => new Response("unavailable", { status: 400 }) })("gemini-3.8-flash");
  await expect(model.stream({ ...input, maxRetries: 0 })).rejects.toThrow();
});
it("keeps Interactions source events on their distinct provider contract", async () => {
  const event = { event_type: "step.delta", index: 0, delta: { type: "google_search_result", sources: [{ uri: "https://example.com" }] } };
  const client = createGemini({ apiKey: "fixture", fetch: async () => sse([event, { event_type: "interaction.completed", interaction: { status: "completed" } }]) });
  const events = []; for await (const e of await client.interactions.stream({ model: "gemini-3.8-flash", input: "Search" })) events.push(e);
  expect(events).toContainEqual({ type: "provider-data", provider: "gemini", data: event });
});
it("preserves partial grounding on truncation without a success finish", async () => {
  const events = await collect([chunk(groundingMetadata)]);
  expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ type: "provider-data" });
});
it("bounds metadata and retains citation placeholders", async () => {
  const events = await collect([chunk({ groundingChunks: [{ web: { uri: "javascript:alert(1)" } }, ...Array.from({ length: 1025 }, () => ({ web: { uri: "https://example.com" } }))], webSearchQueries: ["x".repeat(16385)] }, "STOP")]);
  const data = (events[0] as any).data.groundingMetadata;
  expect(data.groundingChunks).toHaveLength(1024); expect(data.groundingChunks[0]).toEqual({}); expect(data.webSearchQueries).toBeUndefined();
});
