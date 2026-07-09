import { describe, expect, it } from "vitest";

import { generateText, streamText } from "../src/index.js";
import { integrationLanguageProviders } from "./integration-registry.js";

const textProviders = integrationLanguageProviders;
const streamingProviders = integrationLanguageProviders.filter((provider) => provider.supports.streaming);

const describeTextIntegration = textProviders.length ? (describe.sequential ?? describe.skip) : describe.skip;
const describeStreamingIntegration = streamingProviders.length ? (describe.sequential ?? describe.skip) : describe.skip;

describeTextIntegration("generateText capability integration", () => {
  for (const provider of textProviders) {
    it(`${provider.name} generates text with the common SDK contract`, async () => {
      const result = await generateText({
        model: provider.createModel(),
        prompt: `Reply with exactly: integration-${provider.name}-text-ok`,
        temperature: 0,
        maxTokens: 32
      });

      expect(result.text.toLowerCase()).toContain(`integration-${provider.name}-text-ok`);
      expect(result.finishReason).toBeDefined();
      expect(result.usage?.totalTokens ?? result.usage?.inputTokens ?? 0).toBeGreaterThan(0);
    });
  }
});


describeStreamingIntegration("streamText capability integration", () => {
  for (const provider of streamingProviders) {
    it(`${provider.name} streams text with the common SDK contract`, async () => {
      const result = streamText({
        model: provider.createModel(),
        prompt: `Reply with exactly: integration-${provider.name}-stream-ok`,
        temperature: 0,
        maxTokens: 32
      });

      const chunks: string[] = [];
      for await (const chunk of result.textStream) {
        chunks.push(chunk);
      }

      const final = await result.collect();
      expect(chunks.join("")).not.toHaveLength(0);
      expect(final.text.toLowerCase()).toContain(`integration-${provider.name}-stream-ok`);
      expect(final.finishReason).toBeDefined();
    });
  }
});
