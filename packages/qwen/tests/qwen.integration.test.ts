import { describe, expect, it } from "vitest";

import {
  generateImage,
  generateSpeech,
  generateVideo,
  transcribeAudio
} from "@zhivex-ai/core";
import { createQwen, type QwenRegion } from "../src/index.js";

const apiKey = process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY;
const extended = process.env.QWEN_EXTENDED_INTEGRATION === "1";
const workspaceId = process.env.QWEN_WORKSPACE_ID;
const region = process.env.QWEN_REGION as QwenRegion | undefined;
const baseURL = process.env.QWEN_BASE_URL;
const taskBaseURL = process.env.QWEN_TASK_BASE_URL;
const realtimeURL = process.env.QWEN_REALTIME_URL;

const describeIntegration = apiKey && extended ? (describe.sequential ?? describe.skip) : describe.skip;
const enabled = (value: string | undefined) => (value ? it : it.skip);

describeIntegration("qwen extended integration", () => {
  const provider = () =>
    createQwen({
      apiKey,
      workspaceId,
      region,
      baseURL,
      taskBaseURL,
      realtimeURL
    });

  enabled(process.env.QWEN_MULTIMODAL_EMBEDDING_MODEL && process.env.QWEN_MULTIMODAL_IMAGE_URL)(
    "embeds real multimodal content through the native API",
    async () => {
      const result = await provider()
        .multimodalEmbeddingModel(process.env.QWEN_MULTIMODAL_EMBEDDING_MODEL!)
        .embed({
          values: [
            "Zhivex SDK",
            {
              uri: process.env.QWEN_MULTIMODAL_IMAGE_URL!,
              mediaType: "image/png"
            }
          ]
        });

      expect(result.embeddings.length).toBeGreaterThan(0);
      expect(result.embeddings[0]?.length ?? 0).toBeGreaterThan(0);
    }
  );

  enabled(process.env.QWEN_RERANK_MODEL)("reranks real documents", async () => {
    const result = await provider().rerankModel(process.env.QWEN_RERANK_MODEL!).rerank({
      query: "What is Zhivex?",
      documents: ["Zhivex is an AI SDK.", "This sentence is unrelated."],
      topN: 1
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.index).toBe(0);
  });

  enabled(process.env.QWEN_ASR_MODEL && process.env.QWEN_ASR_AUDIO_URL)(
    "transcribes real audio with Qwen ASR",
    async () => {
      const result = await transcribeAudio({
        model: provider().transcriptionModel!(process.env.QWEN_ASR_MODEL!),
        audio: {
          data: process.env.QWEN_ASR_AUDIO_URL!,
          mediaType: process.env.QWEN_ASR_AUDIO_MEDIA_TYPE ?? "audio/mpeg"
        }
      });

      expect(result.text.length).toBeGreaterThan(0);
    }
  );

  enabled(process.env.QWEN_TTS_MODEL)("generates real Qwen speech", async () => {
    const result = await generateSpeech({
      model: provider().speechModel!(process.env.QWEN_TTS_MODEL!),
      input: "Zhivex Qwen integration test.",
      voice: process.env.QWEN_TTS_VOICE ?? "Cherry",
      providerOptions: { language_type: "English" }
    });

    expect(result.audio.byteLength).toBeGreaterThan(0);
    expect(result.mediaType.startsWith("audio/")).toBe(true);
  });

  enabled(process.env.QWEN_IMAGE_MODEL)("generates a real Qwen image", async () => {
    const result = await generateImage({
      model: provider().imageGenerationModel!(process.env.QWEN_IMAGE_MODEL!),
      prompt: "A minimal blue circle icon on a white background",
      count: 1,
      size: "1024*1024",
      providerOptions: { watermark: false }
    });

    expect(result.images[0]?.uri ?? result.images[0]?.data).toBeTruthy();
  });

  enabled(process.env.QWEN_VIDEO_MODEL)("submits a real Qwen video task", async () => {
    const result = await generateVideo({
      model: provider().videoGenerationModel!(process.env.QWEN_VIDEO_MODEL!),
      prompt: "A blue circle gently rotating on a white background",
      durationSeconds: 2,
      aspectRatio: "1:1",
      providerOptions: { resolution: "720P", watermark: false }
    });

    expect(result.operationName).toBeTruthy();
  });

  enabled(process.env.QWEN_REALTIME_MODEL && (workspaceId || realtimeURL))(
    "connects to a real Qwen realtime session",
    async () => {
      const session = await provider().realtimeModel!(process.env.QWEN_REALTIME_MODEL!).connect({
        outputAudioMediaType: "audio/pcm",
        turnDetection: { type: "server_vad" }
      });
      try {
        expect(session.provider).toBe("qwen");
      } finally {
        await session.close();
      }
    }
  );
});
