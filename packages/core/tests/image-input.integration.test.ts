import { describe, it } from "vitest";
import { generateText, streamText, type LanguageModel, type GenerateTextOptions } from "../src/index.js";
import { createOpenAI } from "../../openai/src/index.js";
import { createQwen, type QwenRegion } from "../../qwen/src/index.js";
import { createMeta } from "../../meta/src/index.js";
import { createAnthropic } from "../../anthropic/src/index.js";

// Synthetic 128 x 128 red PNG, never user data.
const image = "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAABWklEQVR4nO3OQQ0AMBAEofVv+iqDxzRBALvtg/wgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwg7gEgaMOyrMtNTwAAAABJRU5ErkJggg==";
const enabled = process.env.INLINE_IMAGE_INTEGRATION === "1";
const metaKey = process.env.META_API_KEY ?? process.env.MODEL_API_KEY ?? process.env.Model_api_key ?? process.env.model_api_key;
const routes = [
  ...(["chat", "responses"] as const).map(apiMode => ({
    name: `meta/${apiMode}`, available: Boolean(metaKey),
    model: () => createMeta({ apiKey: metaKey, baseURL: process.env.META_BASE_URL })(process.env.META_INTEGRATION_MODEL ?? "muse-spark-1.3") as LanguageModel,
    options: { providerOptions: { apiMode }, reasoning: { effort: "minimal" as const }, maxTokens: 512 }
  })),
  ...(["chat", "responses"] as const).map(apiMode => ({
    name: `openai/${apiMode}`, available: Boolean(process.env.OPENAI_API_KEY),
    model: () => createOpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL })(process.env.OPENAI_INTEGRATION_MODEL ?? "gpt-5.6-luna") as LanguageModel,
    options: { providerOptions: { apiMode }, reasoning: { effort: "none" as const }, maxTokens: 512 }
  })),
  ...(["chat", "responses"] as const).map(apiMode => ({
    name: `qwen/${apiMode}`, available: Boolean(process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY),
    model: () => createQwen({ apiKey: process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY, baseURL: process.env.QWEN_BASE_URL,
      workspaceId: process.env.QWEN_WORKSPACE_ID, region: process.env.QWEN_REGION as QwenRegion | undefined })("qwen3.8-flash") as LanguageModel,
    options: apiMode === "chat" ? { providerOptions: { apiMode, enable_thinking: false }, maxTokens: 512 } : { providerOptions: { apiMode } }
  })),
  { name: "anthropic/messages", available: Boolean(process.env.ANTHROPIC_API_KEY),
    model: () => createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY, baseURL: process.env.ANTHROPIC_BASE_URL })(process.env.ANTHROPIC_INTEGRATION_MODEL ?? "claude-opus-5") as LanguageModel,
    options: { maxTokens: 512 }
  }
];
const safeFailure = (error: unknown): Error => {
  const value = error as { name?: string; status?: number; finishReason?: string; outputCharacters?: number };
  // Never log provider response bodies, headers, credentials, or image content.
  return new Error(`Image smoke failed: ${value?.name ?? "unknown"}; status=${value?.status ?? "none"}; finish=${value?.finishReason ?? "none"}; outputCharacters=${value?.outputCharacters ?? "unknown"}`);
};
for (const route of routes) {
  describe.skipIf(!enabled || !route.available)(`live inline image: ${route.name}`, () => {
    const options = (data: string): GenerateTextOptions<LanguageModel> => ({
      model: route.model(), ...route.options, maxRetries: 0, timeoutMs: 45000,
      messages: [{ role: "user", parts: [
        { type: "text", text: "Name the solid color in this image. Answer with one English word." },
        { type: "image", image: data, mediaType: "image/png" }
      ] }]
    });
    for (const representation of ["base64", "data-url"] as const) {
      it.each([false, true])(`${representation}, streaming=%s`, async streaming => {
        try {
          const input = options(representation === "base64" ? image : `data:image/png;base64,${image}`);
          let result;
          if (streaming) {
            const stream = streamText(input);
            let text = "";
            for await (const event of stream.eventStream) {
              if (event.type === "error") throw event.error;
              if (event.type === "text-delta") text += event.textDelta;
            }
            result = await stream.collect();
            if (!text.trim()) throw Object.assign(new Error(), { name: "EmptyStream", finishReason: result.finishReason, outputCharacters: 0 });
          } else result = await generateText(input);
          if (!/\bred\b/i.test(result.text) || result.finishReason !== "stop") throw Object.assign(new Error(), { name: "UnexpectedImageAnswer", finishReason: result.finishReason, outputCharacters: result.text.length });
        } catch (error) { throw safeFailure(error); }
      });
    }
    it("observes a real provider image rejection without collect until later", async () => {
      try {
        // Valid base64 syntax but not an image: exercise the remote HTTP error.
        const result = streamText(options("AQI="));
        let failure: Error | undefined;
        let count = 0;
        let finished = false;
        for await (const event of result.eventStream) {
          if (event.type === "error") { failure = event.error; count++; }
          if (event.type === "finish") finished = true;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
        const status = (failure as Error & { status?: number })?.status;
        const remoteStreamFailure = route.name === "qwen/responses" &&
          (failure as Error & { diagnosticCode?: string })?.diagnosticCode === "QWEN_RESPONSE_FAILED";
        if (count !== 1 || finished || (!remoteStreamFailure && ![400, 422].includes(status ?? 0))) throw failure ?? new Error("MissingProviderImageRejection");
        let rejected = false;
        try { await result.collect(); } catch (error) { rejected = error === failure; }
        if (!rejected) throw new Error("CollectMustPreserveError");
      } catch (error) { throw safeFailure(error); }
    });
  });
}
