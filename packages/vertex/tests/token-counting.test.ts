import { describe, it, expect, vi } from "vitest";
import { createVertex } from "../src/index.js";
const input = { modelId: "claude-sonnet-4-6", messages: [{ role: "user" as const, content: "hello" }], maxRetries: 0 };
describe("Vertex Claude token counting", () => {
  it("uses the dedicated endpoint and preserves native blocks without generation fields", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ input_tokens: 14 }));
    const vertex = createVertex({ projectId: "p", location: "us", accessToken: "test", fetch });
    const tools = [{ name: "lookup", input_schema: { type: "object", properties: {} } }];
    expect(await vertex.claude.countTokens({ ...input, tools })).toMatchObject({ inputTokens: 14 });
    expect(String(fetch.mock.calls[0][0])).toBe("https://aiplatform.us.rep.googleapis.com/v1/projects/p/locations/us/publishers/anthropic/models/count-tokens:rawPredict");
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ model: input.modelId, messages: input.messages, tools });
    expect(new Headers(fetch.mock.calls[0][1]!.headers).get("authorization")).toBe("Bearer test");
    expect(new Headers(fetch.mock.calls[0][1]!.headers).has("anthropic-beta")).toBe(false);
  });
  it("rejects invalid auth, locations and model IDs before fetching", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(createVertex({ apiKey: "key", fetch }).claude.countTokens(input)).rejects.toThrow("bearer");
    await expect(createVertex({ projectId: "p", accessToken: "test", location: "us-east5", fetch }).claude.countTokens(input)).rejects.toThrow("asia-southeast1");
    await expect(createVertex({ projectId: "p", accessToken: "test", fetch }).claude.countTokens({ ...input, modelId: "gemini-3.7-flash" })).rejects.toThrow("Claude model");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects missing counts and preserves HTTP errors instead of generating a fallback response", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(Response.json({ error: "forbidden" }, { status: 403 }));
    const vertex = createVertex({ projectId: "p", accessToken: "test", fetch });
    await expect(vertex.claude.countTokens(input)).rejects.toThrow("invalid token count");
    await expect(vertex.claude.countTokens(input)).rejects.toMatchObject({ status: 403 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("Vertex Gemini token counting", () => {
  it("maps multimodal messages and system instructions to the count endpoint", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ totalTokens: 12, totalBillableCharacters: 24 }));
    const vertex = createVertex({ projectId: "p", location: "global", accessToken: "test", fetch });
    const result = await vertex.gemini.countTokens({ modelId: "publishers/google/models/gemini-2.5-flash", messages: [
      { role: "system", parts: [{ type: "text", text: "Be precise" }] },
      { role: "user", parts: [{ type: "text", text: "hello" }, { type: "image", image: "AQI=", mediaType: "image/png" }] }
    ], generationConfig: { responseMimeType: "text/plain" } });
    expect(result).toMatchObject({ inputTokens: 12, totalBillableCharacters: 24 });
    expect(String(fetch.mock.calls[0][0])).toContain("/publishers/google/models/gemini-2.5-flash:countTokens");
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      contents: [{ role: "user", parts: [{ text: "hello" }, { inlineData: { mimeType: "image/png", data: "AQI=" } }] }],
      systemInstruction: { parts: [{ text: "Be precise" }] }, generationConfig: { responseMimeType: "text/plain" }
    });
  });
  it.each([{}, { totalTokens: -1 }, { totalTokens: "12" }, { totalTokens: 1.5 }, { totalTokens: 1, totalBillableCharacters: -1 }])("rejects malformed count responses", async body => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(body));
    const vertex = createVertex({ projectId: "p", accessToken: "test", fetch });
    await expect(vertex.gemini.countTokens({ modelId: "gemini-2.5-flash", messages: [] })).rejects.toThrow(/invalid/);
  });
  it("retries HTTP failures without allowing partner model routing", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response("busy", { status: 503 })).mockResolvedValueOnce(Response.json({ totalTokens: 0 }));
    const vertex = createVertex({ projectId: "p", accessToken: "test", fetch });
    await expect(vertex.gemini.countTokens({ modelId: "gemini-2.5-flash", messages: [], maxRetries: 1, retryBackoffMs: 1 })).resolves.toMatchObject({ inputTokens: 0 });
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(vertex.gemini.countTokens({ modelId: "claude-sonnet-4-6", messages: [] })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
