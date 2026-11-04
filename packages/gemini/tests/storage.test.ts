import { describe, expect, it, vi } from "vitest";
import { createGemini } from "../src/index.js";
const messages = [{ role: "user" as const, parts: [{ type: "text" as const, text: "Hello" }] }];
describe("Gemini GenerateContent logging", () => {
  it.each([undefined, false, true])("sends explicit storage policy %s in generate and stream", async store => {
    const fetcher = vi.fn().mockImplementation(async (_url, init) => JSON.parse(init.body).stream ? new Response("") : Response.json({ candidates: [] }));
    const model = createGemini({ apiKey: "test", fetch: fetcher })("gemini-3.8-flash");
    await model.generate({ messages, providerOptions: { store } });
    for await (const _ of await model.stream({ messages, providerOptions: { store } })) { /* consume */ }
    for (const [, init] of fetcher.mock.calls) expect(JSON.parse(init.body).store).toBe(store ?? false);
  });
  it("rejects nonboolean storage before sending", async () => {
    const fetcher = vi.fn();
    const model = createGemini({ apiKey: "test", fetch: fetcher })("gemini-3.8-flash");
    await expect(model.generate({ messages, providerOptions: { store: "true" as any } })).rejects.toThrow("boolean");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
