import { describe, expect, it, vi } from "vitest";
import { createBatch } from "@zhivex-ai/core";
import { createGemini } from "../src/index.js";
const messages = [{ role: "user" as const, parts: [{ type: "text" as const, text: "Hello" }] }];
describe("Gemini GenerateContent logging", () => {
  it.each([undefined, false, true])("sends explicit storage policy %s in generate and stream", async store => {
    const fetcher = vi.fn().mockImplementation(async (url) => String(url).includes(":streamGenerateContent") ? new Response("") : Response.json({ candidates: [] }));
    const model = createGemini({ apiKey: "test", fetch: fetcher })("gemini-3.8-flash");
    await model.generate({ messages, providerOptions: { store } });
    for await (const _ of await model.stream({ messages, providerOptions: { store } })) { /* consume */ }
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0][0])).toContain(":generateContent?");
    expect(String(fetcher.mock.calls[1][0])).toContain(":streamGenerateContent?");
    for (const [, init] of fetcher.mock.calls) expect(JSON.parse(init.body).store).toBe(store ?? false);
  });
  it("rejects nonboolean storage before sending", async () => {
    const fetcher = vi.fn();
    const model = createGemini({ apiKey: "test", fetch: fetcher })("gemini-3.8-flash");
    await expect(model.generate({ messages, providerOptions: { store: "true" as any } })).rejects.toThrow("boolean");
    expect(fetcher).not.toHaveBeenCalled();
  });
});


describe("Gemini per-request Batch logging", () => {
  it("defaults inline requests to false and preserves explicit true/false, metadata and input objects", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ name: "batches/1" }));
    const provider = createGemini({ apiKey: "test", fetch: fetcher });
    const requests = [undefined, false, true].map(store => ({ request: { contents: [], ...(store === undefined ? {} : { store }) }, metadata: { key: String(store) } }));
    const original = structuredClone(requests);
    await createBatch({ provider, modelId: "gemini-3.8-flash", requests });
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.batch.inputConfig.requests.requests.map((item: any) => item.request.store)).toEqual([false, false, true]);
    expect(body.batch.inputConfig.requests.requests.map((item: any) => item.metadata)).toEqual(requests.map(item => item.metadata));
    expect(requests).toEqual(original);
    expect(body).not.toHaveProperty("store");
    expect(body.batch).not.toHaveProperty("store");
  });
  it("normalizes raw inline inputConfig overrides and rejects invalid stores", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ name: "batches/1" }));
    const provider = createGemini({ apiKey: "test", fetch: fetcher });
    await createBatch({ provider, modelId: "gemini-3.8-flash", providerOptions: { inputConfig: { requests: { requests: [{ request: { contents: [] } }] } } } });
    expect(JSON.parse(fetcher.mock.calls[0][1].body).batch.inputConfig.requests.requests[0].request.store).toBe(false);
    await expect(createBatch({ provider, modelId: "gemini-3.8-flash", requests: [{ request: { store: "true" } }] })).rejects.toThrow("boolean");
    await expect(createBatch({ provider, modelId: "gemini-3.8-flash", providerOptions: { store: false } })).rejects.toThrow("each GenerateContentRequest");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("preserves opaque uploaded file references without claiming a logging override", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ name: "batches/1" }));
    const provider = createGemini({ apiKey: "test", fetch: fetcher });
    await createBatch({ provider, modelId: "gemini-3.8-flash", fileName: "files/prepared-jsonl" });
    expect(JSON.parse(fetcher.mock.calls[0][1].body).batch.inputConfig).toEqual({ fileName: "files/prepared-jsonl" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
