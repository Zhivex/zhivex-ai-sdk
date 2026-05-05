import { expect, it } from "vitest";

import { inspectProviderAgentSupport } from "../src/index.js";
import type { AgentSupportTier, EmbeddingModel, LanguageModel, ModelCapabilities } from "../src/index.js";

interface LanguageModelContractOptions {
  providerName: string;
  modelId: string;
  createModel: () => LanguageModel;
  expectedCapabilities: ModelCapabilities;
  expectedAgentTier: AgentSupportTier;
  createEmbeddingModel?: () => EmbeddingModel;
}

export const runLanguageModelContractSuite = (options: LanguageModelContractOptions) => {
  it("exposes stable language model identity", () => {
    const model = options.createModel();

    expect(model.provider).toBe(options.providerName);
    expect(model.modelId).toBe(options.modelId);
  });

  it("declares the expanded capabilities contract", () => {
    const model = options.createModel();

    expect(model.capabilities).toMatchObject(options.expectedCapabilities);
    expect(model.capabilities.agentCapabilities).toBeDefined();
    expect(model.capabilities.agentCapabilities?.supportTier).toBe(options.expectedAgentTier);
    expect(inspectProviderAgentSupport(model)).toMatchObject({
      provider: options.providerName,
      modelId: options.modelId,
      agentTier: options.expectedAgentTier,
      portableToolLoop: model.capabilities.tools,
      streaming: model.capabilities.streaming,
      structuredOutput: model.capabilities.structuredOutput,
      reasoning: model.capabilities.reasoning
    });
  });

  if (options.createEmbeddingModel) {
    it("exposes embedding model identity when supported", () => {
      const model = options.createEmbeddingModel?.();

      expect(model?.provider).toBe(options.providerName);
      expect(model?.capabilities.embeddings).toBe(true);
    });
  }
};
