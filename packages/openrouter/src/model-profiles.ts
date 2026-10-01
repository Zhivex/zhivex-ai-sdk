import type { ModelCapabilities } from "@zhivex-ai/core/provider";

const legacyCapabilities: ModelCapabilities = {
  streaming: true,
  tools: true,
  structuredOutput: true,
  jsonMode: true,
  toolChoice: true,
  parallelToolCalls: true,
  vision: true,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
  reasoning: true,
  webSearch: true,
  agentCapabilities: {
    supportTier: "tier-c",
    toolChoiceNone: true,
    approvalRequests: false,
    hostedWebSearch: true,
    hostedFileSearch: false,
    remoteMcp: false,
    computerUse: false,
    codeExecution: false,
    toolsets: false
  }
};

// Host support is model-specific. Add only profiles backed by adapter tests.
export const resolveOpenRouterCapabilities = (
  modelId: string,
  policy: "conservative" | "legacy" = "conservative",
  overrides?: Omit<Partial<ModelCapabilities>, "agentCapabilities"> & {
    agentCapabilities?: Partial<NonNullable<ModelCapabilities["agentCapabilities"]>>;
  }
): ModelCapabilities => {
  const known = ["openai/gpt-4o-mini", "meta/muse-spark-1.2", "meta/muse-glimmer-30b"].includes(modelId);
  const base = {
    ...legacyCapabilities,
    ...(!known && policy === "conservative" ? {
      tools: false, structuredOutput: false, jsonMode: false, toolChoice: false,
      parallelToolCalls: false, vision: false, reasoning: false,
      agentCapabilities: { ...legacyCapabilities.agentCapabilities!, toolChoiceNone: false },
    } : {}),
  };
  return { ...base, ...overrides, agentCapabilities: { ...base.agentCapabilities!, ...overrides?.agentCapabilities } };
};
