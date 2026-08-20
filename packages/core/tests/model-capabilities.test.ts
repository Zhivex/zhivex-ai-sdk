import { describe, expect, it } from "vitest";

import {
  deriveLegacyModelCapabilities,
  isModelCapabilitySupported,
  MODEL_CAPABILITY_SUPPORT_LEVELS,
  type LanguageModelCapabilityProfile,
  type ModelCapabilityProfile
} from "../src/model-capabilities.js";

const noAgentCapabilities = {
  supportTier: "tier-c",
  toolChoiceNone: false,
  approvalRequests: false,
  hostedWebSearch: false,
  hostedFileSearch: false,
  remoteMcp: false,
  computerUse: false,
  codeExecution: false,
  toolsets: false
} as const;

describe("model capability profiles v2", () => {
  it("defines the supported capability levels", () => {
    expect(MODEL_CAPABILITY_SUPPORT_LEVELS).toEqual([
      "unsupported",
      "native",
      "prompted",
      "model-dependent"
    ]);
    expect(isModelCapabilitySupported("unsupported")).toBe(false);
    expect(isModelCapabilitySupported(undefined)).toBe(false);
    expect(isModelCapabilitySupported("native")).toBe(true);
    expect(isModelCapabilitySupported("prompted")).toBe(true);
    expect(isModelCapabilitySupported("model-dependent")).toBe(true);
  });

  it("derives the language-model legacy contract without unrelated flags", () => {
    const profile = {
      kind: "language",
      capabilities: {
        streaming: "native",
        tools: "native",
        structuredOutput: "prompted",
        jsonMode: "unsupported",
        toolChoice: "model-dependent",
        files: "native",
        explicitPromptCaching: "model-dependent",
        reasoning: "native",
        webSearch: "native"
      },
      reasoningDetails: {
        efforts: ["low", "high"],
        modes: ["standard"],
        contexts: ["current_turn"]
      },
      agent: {
        support: "native",
        capabilities: noAgentCapabilities
      }
    } satisfies LanguageModelCapabilityProfile;

    expect(deriveLegacyModelCapabilities(profile)).toEqual({
      streaming: true,
      tools: true,
      structuredOutput: true,
      jsonMode: false,
      toolChoice: true,
      parallelToolCalls: false,
      vision: false,
      files: true,
      audioInput: false,
      audioOutput: false,
      embeddings: false,
      reasoning: true,
      webSearch: true,
      explicitPromptCaching: true,
      reasoningEfforts: ["low", "high"],
      reasoningModes: ["standard"],
      reasoningContexts: ["current_turn"],
      agentCapabilities: noAgentCapabilities
    });
  });

  it("omits optional legacy details when their parent capability is unsupported", () => {
    const profile = {
      kind: "language",
      capabilities: { reasoning: "unsupported" },
      reasoningDetails: { efforts: ["high"] },
      agent: {
        support: "unsupported",
        capabilities: noAgentCapabilities
      }
    } satisfies LanguageModelCapabilityProfile;

    const legacy = deriveLegacyModelCapabilities(profile);

    expect(legacy.reasoning).toBe(false);
    expect(legacy.reasoningEfforts).toBeUndefined();
    expect(legacy.agentCapabilities).toBeUndefined();
  });

  it.each<{
    profile: ModelCapabilityProfile;
    expected: Record<string, unknown>;
  }>([
    {
      profile: {
        kind: "embedding",
        capabilities: { embeddings: "native", batch: "native" }
      },
      expected: { embeddings: true, batch: true }
    },
    {
      profile: {
        kind: "transcription",
        capabilities: { audioInput: "native" }
      },
      expected: { audioInput: true }
    },
    {
      profile: {
        kind: "speech",
        capabilities: { audioOutput: "native", streaming: "native" }
      },
      expected: { audioOutput: true, streaming: true }
    },
    {
      profile: {
        kind: "image-generation",
        capabilities: {
          imageGeneration: "native",
          imageInput: "model-dependent"
        }
      },
      expected: { imageGeneration: true, vision: true }
    },
    {
      profile: {
        kind: "video-generation",
        capabilities: {
          videoGeneration: "native",
          imageInput: "native",
          audioOutput: "native"
        }
      },
      expected: { videoGeneration: true, vision: true, audioOutput: true }
    },
    {
      profile: {
        kind: "music-generation",
        capabilities: {
          musicGeneration: "native",
          imageInput: "prompted",
          audioInput: "model-dependent",
          audioOutput: "native"
        }
      },
      expected: {
        musicGeneration: true,
        vision: true,
        audioInput: true,
        audioOutput: true
      }
    }
  ])("maps $profile.kind capabilities to the legacy fields", ({ profile, expected }) => {
    expect(deriveLegacyModelCapabilities(profile)).toMatchObject(expected);
  });

  it("derives both flat and nested realtime compatibility fields", () => {
    const profile = {
      kind: "realtime",
      capabilities: {
        sessions: "native",
        streaming: "native",
        audioInput: "native",
        audioOutput: "native",
        imageInput: "model-dependent",
        tools: "native",
        browserTokens: "unsupported"
      },
      agent: {
        support: "model-dependent",
        capabilities: noAgentCapabilities
      }
    } satisfies ModelCapabilityProfile;

    expect(deriveLegacyModelCapabilities(profile)).toMatchObject({
      streaming: true,
      tools: true,
      vision: true,
      audioInput: true,
      audioOutput: true,
      realtime: {
        sessions: true,
        audioInput: true,
        audioOutput: true,
        imageInput: true,
        tools: true,
        browserTokens: false
      },
      agentCapabilities: noAgentCapabilities
    });
  });
});
