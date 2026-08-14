import { describe, expect, it } from "vitest";

import { generateText, streamText } from "@zhivex-ai/core";
import { createZAI } from "../src/index.js";

const apiKey = process.env.ZAI_API_KEY;
const extended = process.env.ZAI_EXTENDED_INTEGRATION === "1";
const baseURL = process.env.ZAI_BASE_URL;
const endpoint = process.env.ZAI_ENDPOINT === "coding" ? "coding" : "general";
const modelId = process.env.ZAI_INTEGRATION_MODEL ?? (endpoint === "coding" ? "glm-5.3" : "glm-5.2");
const describeIntegration = apiKey && extended ? (describe.sequential ?? describe.skip) : describe.skip;

describeIntegration("Z.ai extended integration", () => {
  const model = () => createZAI({ apiKey, baseURL, endpoint })(modelId);

  it("generates with the selected live GLM endpoint", async () => {
    const result = await generateText({
      model: model(),
      prompt: "Reply with the single word pong.",
      maxTokens: 128,
      reasoning: { effort: modelId === "glm-5.3" ? "low" : "high" }
    });
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.finishReason).toBeDefined();
  });

  it("streams text and reasoning from the selected live GLM endpoint", async () => {
    const result = streamText({
      model: model(),
      prompt: "Reply with a short greeting.",
      maxTokens: 128,
      reasoning: { effort: modelId === "glm-5.3" ? "low" : "high" }
    });
    const final = await result.collect();
    expect(final.text.length).toBeGreaterThan(0);
    expect(final.finishReason).toBeDefined();
  });
});
