import { describe, expect, it } from "vitest";

import { generateText } from "@zhivex-ai/core";
import { createDeepSeek } from "../src/index.js";

const apiKey = process.env.DEEPSEEK_API_KEY;
const extended = process.env.DEEPSEEK_EXTENDED_INTEGRATION === "1";
const baseURL = process.env.DEEPSEEK_BASE_URL;
const betaBaseURL = process.env.DEEPSEEK_BETA_BASE_URL;

const describeIntegration = apiKey && extended ? (describe.sequential ?? describe.skip) : describe.skip;

describeIntegration("deepseek extended integration", () => {
  const provider = () => createDeepSeek({ apiKey, baseURL, betaBaseURL });

  it("lists the live DeepSeek model catalog", async () => {
    const result = await provider().models.list();

    expect(result.models.some((model) => model.id === "deepseek-v4-pro")).toBe(true);
  });

  it("reads the live account balance", async () => {
    const result = await provider().balance.get();

    expect(typeof result.isAvailable).toBe("boolean");
    expect(result.balances.length).toBeGreaterThan(0);
  });

  it("generates and streams live FIM completions through beta", async () => {
    const deepseek = provider();
    const generated = await deepseek.fim.generate({
      prompt: "const deepSeekIntegration = ",
      suffix: ";\n",
      maxTokens: 32
    });

    expect(generated.text.length).toBeGreaterThan(0);
    expect(generated.finishReason).toBeDefined();

    const chunks: string[] = [];
    let finishSeen = false;
    for await (const event of await deepseek.fim.stream({
      prompt: "const deepSeekStreamingIntegration = ",
      suffix: ";\n",
      maxTokens: 32
    })) {
      if (event.type === "text-delta") {
        chunks.push(event.textDelta);
      } else {
        finishSeen = true;
      }
    }

    expect(chunks.join("").length).toBeGreaterThan(0);
    expect(finishSeen).toBe(true);
  });

  it("continues a live assistant prefix through beta", async () => {
    const deepseek = provider();
    const result = await generateText({
      model: deepseek("deepseek-v4-pro"),
      prompt: "Complete the assistant prefix with a short valid sentence.",
      maxTokens: 32,
      providerOptions: {
        prefix: { content: "The verified result is" }
      }
    });

    expect(result.text.length).toBeGreaterThan(0);
    expect(result.finishReason).toBeDefined();
  });
});
