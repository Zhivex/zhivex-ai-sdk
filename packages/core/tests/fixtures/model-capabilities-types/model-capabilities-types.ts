import type {
  EmbeddingModelCapabilityProfile,
  LanguageModelCapabilityProfile,
  ModelCapabilityProfile
} from "../../../src/model-capabilities.js";

const embeddingProfile: EmbeddingModelCapabilityProfile = {
  kind: "embedding",
  capabilities: {
    embeddings: "native",
    batch: "model-dependent"
  }
};

const languageProfile: LanguageModelCapabilityProfile = {
  kind: "language",
  capabilities: {
    tools: "native",
    structuredOutput: "prompted"
  }
};

const invalidEmbeddingProfile: EmbeddingModelCapabilityProfile = {
  kind: "embedding",
  capabilities: {
    // @ts-expect-error Language-only capabilities cannot leak into embedding profiles.
    tools: "native"
  }
};

const invalidSupportLevel: ModelCapabilityProfile = {
  kind: "speech",
  capabilities: {
    // @ts-expect-error Support levels are intentionally closed and machine-readable.
    audioOutput: "partial"
  }
};

void embeddingProfile;
void languageProfile;
void invalidEmbeddingProfile;
void invalidSupportLevel;
