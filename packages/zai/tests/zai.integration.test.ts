import { describe, expect, it } from "vitest";

import { generateText, streamText } from "@zhivex-ai/core";
import { createZAI } from "../src/index.js";

const apiKey = process.env.ZAI_API_KEY;
const extended = process.env.ZAI_EXTENDED_INTEGRATION === "1";
const baseURL = process.env.ZAI_BASE_URL;
const endpoint = process.env.ZAI_ENDPOINT === "coding" ? "coding" : "general";
const modelId = process.env.ZAI_INTEGRATION_MODEL ?? "glm-5.3-flash";
const isGLM53Family = /^glm-5\.3(?:-flash)?$/i.test(modelId);
const isGLM53Flash = /^glm-5\.3-flash$/i.test(modelId);
const describeIntegration = apiKey && extended ? (describe.sequential ?? describe.skip) : describe.skip;
const enabled = (value: unknown) => (value ? it : it.skip);

describeIntegration("Z.ai extended integration", () => {
  const model = () => createZAI({ apiKey, baseURL, endpoint })(modelId);

  it("generates with the selected live GLM endpoint", async () => {
    const result = await generateText({
      model: model(),
      prompt: "Reply with the single word pong.",
      maxTokens: 128,
      reasoning: { effort: isGLM53Family ? "low" : "high" }
    });
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.finishReason).toBeDefined();
  });

  it("streams text and reasoning from the selected live GLM endpoint", async () => {
    const result = streamText({
      model: model(),
      prompt: "Reply with a short greeting.",
      maxTokens: 128,
      reasoning: { effort: isGLM53Family ? "low" : "high" }
    });
    const final = await result.collect();
    expect(final.text.length).toBeGreaterThan(0);
    expect(final.finishReason).toBeDefined();
  });

  enabled(isGLM53Flash && process.env.ZAI_INTEGRATION_IMAGE_URL)(
    "understands a real image with GLM-5.3 Flash",
    async () => {
      const result = await generateText({
        model: model(),
        messages: [
          {
            role: "user",
            parts: [
              { type: "text", text: "Describe this image in one short sentence." },
              {
                type: "image",
                image: process.env.ZAI_INTEGRATION_IMAGE_URL!,
                mediaType: process.env.ZAI_INTEGRATION_IMAGE_MEDIA_TYPE ?? "image/png"
              }
            ]
          }
        ],
        maxTokens: 256,
        reasoning: { effort: "low" }
      });
      expect(result.text.length).toBeGreaterThan(0);
      expect(result.finishReason).toBeDefined();
    }
  );
});
