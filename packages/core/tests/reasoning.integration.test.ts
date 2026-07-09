import { describe, expect, it } from "vitest";

import { generateText } from "../src/index.js";
import { integrationLanguageProviders } from "./integration-registry.js";

const reasoningProviders = integrationLanguageProviders.filter((provider) => provider.supports.reasoning);
const describeReasoningIntegration = reasoningProviders.length ? (describe.sequential ?? describe.skip) : describe.skip;

describeReasoningIntegration("reasoning capability integration", () => {
  for (const provider of reasoningProviders) {
    it(`${provider.name} accepts the common reasoning config`, async () => {
      const result = await generateText({
        model: provider.createModel(),
        prompt: `Reply with exactly: integration-${provider.name}-reasoning-ok`,
        temperature: 0,
        maxTokens: 64,
        reasoning: provider.supports.reasoning
      });

      expect(result.text.toLowerCase()).toContain(`integration-${provider.name}-reasoning-ok`);
      expect(result.finishReason).toBeDefined();
    });
  }
});
