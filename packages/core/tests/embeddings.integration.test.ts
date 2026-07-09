import { describe, expect, it } from "vitest";

import { embed } from "../src/index.js";
import { integrationLanguageProviders } from "./integration-registry.js";

const embeddingProviders = integrationLanguageProviders.filter(
  (provider) => provider.supports.embeddings && provider.createEmbeddingModel
);

const describeEmbeddingIntegration = embeddingProviders.length ? (describe.sequential ?? describe.skip) : describe.skip;

describeEmbeddingIntegration("embeddings capability integration", () => {
  for (const provider of embeddingProviders) {
    it(`${provider.name} embeds text through the common SDK contract`, async () => {
      const result = await embed({
        model: provider.createEmbeddingModel!(),
        value: `${provider.name} integration embedding vector`
      });

      expect(result.embeddings).toHaveLength(1);
      expect(result.embeddings[0]?.length ?? 0).toBeGreaterThan(0);
      expect(result.usage?.totalTokens ?? result.usage?.inputTokens ?? 1).toBeGreaterThan(0);
    });
  }
});
