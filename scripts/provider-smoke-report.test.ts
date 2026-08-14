import { describe, expect, it } from "vitest";

import { integrationProviderStatuses } from "../packages/core/tests/integration-registry.js";

describe("provider smoke registry", () => {
  it("accounts for every live provider route, including Meta and opt-in Ollama", () => {
    const providerNames = integrationProviderStatuses.map((provider) => provider.name);
    expect(providerNames).toEqual([
      "openai",
      "xai",
      "meta",
      "azure-openai",
      "anthropic",
      "gemini",
      "openrouter",
      "deepseek",
      "zai",
      "qwen",
      "kimi",
      "bedrock-converse",
      "bedrock-openai",
      "ollama",
      "vertex"
    ]);
    expect(new Set(providerNames).size).toBe(providerNames.length);
  });

  it("describes Meta credentials and Ollama opt-in requirements", () => {
    expect(integrationProviderStatuses.find((provider) => provider.name === "meta"))
      .toMatchObject({ credentialRequirements: ["MODEL_API_KEY"] });
    expect(integrationProviderStatuses.find((provider) => provider.name === "ollama"))
      .toMatchObject({
        credentialRequirements: ["OLLAMA_INTEGRATION=1 (a reachable Ollama service is also required)"],
        embeddingModelId: "embeddinggemma"
      });
  });
});
