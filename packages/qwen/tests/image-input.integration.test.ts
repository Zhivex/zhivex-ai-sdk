import { describe, expect, it } from "vitest";
import { generateText, streamText } from "@zhivex-ai/core";
import { createQwen, type QwenRegion } from "../src/index.js";

const apiKey = process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY;
const enabled = process.env.QWEN_IMAGE_INTEGRATION === "1" && Boolean(apiKey);
// Synthetic 128 x 128 red PNG; no user content.
const image = "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAABWklEQVR4nO3OQQ0AMBAEofVv+iqDxzRBALvtg/wgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwgzg/i/CDOD+L8IM4P4vwg7gEgaMOyrMtNTwAAAABJRU5ErkJggg==";

describe.skipIf(!enabled)("Qwen inline image integration", () => {
  it.each([false, true])("accepts bare base64 (streaming=%s)", async streaming => {
    const model = createQwen({ apiKey, workspaceId: process.env.QWEN_WORKSPACE_ID,
      region: process.env.QWEN_REGION as QwenRegion | undefined, baseURL: process.env.QWEN_BASE_URL })("qwen3.8-flash");
    const options = { model, messages: [{ role: "user" as const, parts: [
      { type: "text" as const, text: "Name the solid color in this image. Answer with one English word." },
      { type: "image" as const, image, mediaType: "image/png" }
    ] }], providerOptions: { apiMode: "chat" as const, enable_thinking: false }, maxTokens: 512, maxRetries: 0, timeoutMs: 45000 };
    // Only allowlisted diagnostics escape the test on failure.
    try {
      const result = streaming ? await streamText(options).collect() : await generateText(options);
      expect(result.text.trim().length).toBeGreaterThan(0);
      expect(result.text.toLowerCase()).toContain("red");
      expect(result.finishReason).toBe("stop");
    } catch (error) {
      throw new Error(`Qwen image smoke failed: ${error instanceof Error ? error.name : "unknown"}; status=${(error as { status?: number })?.status ?? "none"}`);
    }
  });
});
