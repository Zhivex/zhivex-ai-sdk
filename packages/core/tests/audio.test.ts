import { describe, expect, it } from "vitest";

import {
  streamSpeech,
  type ModelCapabilities,
  type SpeechModel,
  type SpeechResult
} from "../src/index.js";

const capabilities: ModelCapabilities = {
  streaming: true,
  tools: false,
  structuredOutput: false,
  jsonMode: false,
  toolChoice: false,
  parallelToolCalls: false,
  vision: false,
  files: false,
  audioInput: false,
  audioOutput: true,
  embeddings: false
};

describe("streamSpeech", () => {
  it("exposes provider audio chunks through the shared speech contract", async () => {
    const model: SpeechModel = {
      provider: "test",
      modelId: "streaming-voice",
      capabilities,
      generateSpeech: async () => ({ audio: new Uint8Array(), mediaType: "audio/pcm" }),
      streamSpeech: async () =>
        (async function* (): AsyncGenerator<SpeechResult> {
          yield { audio: new Uint8Array([1, 2]), mediaType: "audio/pcm" };
          yield { audio: new Uint8Array([3, 4]), mediaType: "audio/pcm" };
        })()
    };

    const chunks = [];
    for await (const chunk of await streamSpeech({ model, input: "hello" })) {
      chunks.push({ ...chunk, audio: Array.from(chunk.audio) });
    }

    expect(chunks).toEqual([
      { audio: [1, 2], mediaType: "audio/pcm", input: "hello" },
      { audio: [3, 4], mediaType: "audio/pcm", input: "hello" }
    ]);
  });

  it("fails clearly when a speech model has no streaming implementation", async () => {
    const model: SpeechModel = {
      provider: "test",
      modelId: "batch-only-voice",
      capabilities: { ...capabilities, streaming: false },
      generateSpeech: async () => ({ audio: new Uint8Array(), mediaType: "audio/pcm" })
    };

    await expect(streamSpeech({ model, input: "hello" })).rejects.toThrow(
      'Model "test/batch-only-voice" does not support streaming speech.'
    );
  });
});
