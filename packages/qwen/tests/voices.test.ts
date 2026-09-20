import { describe, expect, it, vi } from "vitest";
import { createQwen } from "../src/index.js";
const input = { targetModel: "qwen3.8-livetranslate-flash-realtime", preferredName: "audit", audio: "data:audio/wav;base64,AAAA" };
const fixture = (responses: unknown[] = [{ output: { voice: "custom-returned-id", target_model: input.targetModel, fallback_mode: false } }]) => {
  const fetch = vi.fn(async () => Response.json(responses.shift()));
  return { fetch, provider: createQwen({ apiKey: "test", workspaceId: "ws_test", fetch: fetch as typeof globalThis.fetch }) };
};
describe("Qwen voice enrollment", () => {
  it("uses the regional native endpoint and preserves the returned opaque voice ID", async () => {
    const { provider, fetch } = fixture();
    expect(await provider.voices.create(input)).toEqual({ voice: "custom-returned-id", targetModel: input.targetModel, fallbackMode: false });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ws_test.ap-southeast-1.maas.aliyuncs.com/api/v1/services/audio/tts/customization");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(String(init.body))).toEqual({ model: "qwen-voice-enrollment", input: { action: "create", target_model: input.targetModel, preferred_name: "audit", audio: { data: input.audio } } });
  });
  it("lists and deletes only the requested voice", async () => {
    const { provider, fetch } = fixture([{ output: { voice_list: [{ voice: "v1" }], total_count: 1 } }, { output: { voice: "v1" } }]);
    expect(await provider.voices.list()).toEqual({ voices: [{ voice: "v1" }], totalCount: 1 });
    await provider.voices.delete({ voice: "v1" });
    const init = (fetch.mock.calls[1] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body)).input).toEqual({ action: "delete", voice: "v1" });
  });
  it.each([{ preferredName: "bad-name" }, { audio: "http://example.com/a.wav" }, { audio: "file:///etc/passwd" }, { audio: "data:audio/wav;base64,?" }, { targetModel: "" }])("rejects invalid input before network: %j", async override => {
    const { provider, fetch } = fixture();
    await expect(provider.voices.create({ ...input, ...override })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not retry uncertain creates or expose audio echoed by the server", async () => {
    const fetch = vi.fn(async () => Response.json({ code: "UnsupportedModel", message: input.audio }, { status: 503 }));
    const provider = createQwen({ apiKey: "test", fetch: fetch as typeof globalThis.fetch });
    const error = await provider.voices.create(input).catch(error => error);
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify(error)).not.toContain(input.audio);
    expect(error.status).toBe(503);
  });
  it("does not report cleanup success without confirmation of the exact voice", async () => {
    const { provider } = fixture([{ output: { voice: "another-voice" } }]);
    await expect(provider.voices.delete({ voice: "temporary-voice" })).rejects.toThrow(/confirm deletion/);
  });
  it("rejects successful responses without an identifier", async () => {
    const { provider } = fixture([{ output: {} }]);
    await expect(provider.voices.create(input)).rejects.toThrow(/identifier/);
  });
});
