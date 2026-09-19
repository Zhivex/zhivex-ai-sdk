import { describe, expect, it, vi } from "vitest";
import { createVertex } from "../src/index.js";

const audio = { data: "AQID", mediaType: "audio/wav" };
const setup = (response: object = { candidates: [{ content: { parts: [] } }] }) => {
  const fetch = vi.fn(async () => Response.json(response));
  const vertex = createVertex({ projectId: "p", accessToken: "synthetic", fetch: fetch as typeof globalThis.fetch });
  return { fetch, vertex };
};
describe("Vertex dedicated transcription", () => {
  it.each(["gemini-3.5-transcribe-preview", "gemini-3.5-transcribe-live-preview", "gemini-3.5-live-translate-preview"])("rejects the chat factories for dedicated audio model %s", modelId => {
    const { vertex, fetch } = setup();
    expect(() => vertex(modelId)).toThrow("requires");
    expect(() => vertex.languageModel(modelId)).toThrow("requires");
    expect(() => vertex.groundedLanguageModel!(modelId)).toThrow("requires");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("advertises only the synchronous audio surfaces instead of inherited chat operations", () => {
    const { vertex } = setup();
    for (const model of [vertex.transcriptionModel("gemini-3.5-transcribe-preview"), vertex.transcriptionModel("gemini-2.5-flash"), vertex.speechModel!("gemini-2.5-flash-preview-tts")]) {
      expect(model.capabilities).toMatchObject({ vision: false, files: false, urlContext: false, contextCaching: false, batch: false, rawPrediction: false, computerUse: false, tools: false, webSearch: false, embeddings: false });
    }
    expect(vertex.transcriptionModel("gemini-3.5-transcribe-preview").capabilities).toMatchObject({ audioInput: true, audioOutput: false });
    expect(vertex.speechModel!("gemini-2.5-flash-preview-tts").capabilities).toMatchObject({ audioInput: false, audioOutput: true });
  });
  it("sends audio-only contents with native language and recognition configuration", async () => {
    const { fetch, vertex } = setup();
    await vertex.transcriptionModel("gemini-3.5-transcribe-preview").transcribe({ audio, language: "es-AR", providerOptions: { audioTranscriptionConfig: { customVocabulary: ["Zhivex"], wordTimestamp: true, diarization: true } } });
    const request = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(request.contents).toEqual([{ role: "user", parts: [{ inlineData: { mimeType: "audio/wav", data: "AQID" } }] }]);
    expect(request.generationConfig.audioTranscriptionConfig).toEqual({ languageCodes: ["es-AR"], customVocabulary: ["Zhivex"], wordTimestamp: true, diarization: true });
  });
  it("preserves all transcript parts, speaker labels and exact duration strings", async () => {
    const first = { text: "Hello ", speakerLabel: "spk_1", languageCode: "en-US", words: [{ word: "Hello", startOffset: "0.100000001s", endOffset: "0.5s" }] };
    const second = { text: "world", speakerLabel: "spk_2", finished: true };
    const { vertex } = setup({ candidates: [{ content: { parts: [{ audioTranscription: first }, { audioTranscription: second }] } }] });
    const result = await vertex.transcriptionModel("gemini-3.5-transcribe-preview").transcribe({ audio });
    expect(result.text).toBe("Hello world");
    expect(result.transcriptions).toEqual([first, second]);
  });
  it("joins legacy text chunks, excludes thoughts and avoids duplicate text within a part", async () => {
    const { vertex } = setup({ candidates: [{ content: { parts: [{ text: "hidden", thought: true }, { text: "One " }, { text: "two", audioTranscription: { text: "two" } }] } }] });
    expect((await vertex.transcriptionModel("gemini-2.5-flash").transcribe({ audio })).text).toBe("One two");
  });
  it.each([
    { mode: "SMART", diarization: true },
    { mode: "SMART", wordTimestamp: true },
    { customVocabulary: Array(1001).fill("term") },
    { wordTimestamp: "true" },
    { languageCodes: [""] },
    { unsupported: true }
  ])("rejects unsupported recognition configuration before network access: %j", async config => {
    const { fetch, vertex } = setup();
    await expect(vertex.transcriptionModel("gemini-3.5-transcribe-preview").transcribe({ audio, providerOptions: { audioTranscriptionConfig: config as any } })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects prompt and conflicting native overrides", async () => {
    const { fetch, vertex } = setup();
    const model = vertex.transcriptionModel("gemini-3.5-transcribe-preview");
    await expect(model.transcribe({ audio, prompt: "summarize" })).rejects.toThrow("not a text prompt");
    await expect(model.transcribe({ audio, language: "es", providerOptions: { audioTranscriptionConfig: { languageCodes: ["en"] } } })).rejects.toThrow("conflicts");
    await expect(model.transcribe({ audio, providerOptions: { generationConfig: { audioTranscriptionConfig: {} } } })).rejects.toThrow("dedicated");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects regional placement and the separate Live model in the synchronous factory", () => {
    const { vertex } = setup();
    expect(() => vertex.transcriptionModel("gemini-3.5-transcribe-live-preview")).toThrow("realtime");
    expect(() => createVertex({ projectId: "p", accessToken: "synthetic", location: "us-central1" }).transcriptionModel("gemini-3.5-transcribe-preview")).toThrow("not available");
  });
  it("rejects malformed native results", async () => {
    const { vertex } = setup({ candidates: [{ content: { parts: [{ audioTranscription: { words: [{ word: "hi", startOffset: 0 }] } }] } }] });
    await expect(vertex.transcriptionModel("gemini-3.5-transcribe-preview").transcribe({ audio })).rejects.toThrow("word information");
  });
});
