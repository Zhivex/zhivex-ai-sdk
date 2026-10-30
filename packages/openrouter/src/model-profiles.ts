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
    // Upstream models vary. Server tools are not a durable-agent contract.
    durableAgent: false,
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

const legacyKnownModelIds = ["openai/gpt-4o-mini", "meta/muse-spark-1.2", "meta/muse-glimmer-30b"];

/** OpenRouter `reasoning.supported_efforts` for meta/muse-spark-open. Reasoning is mandatory. */
const museSparkOpenEfforts = ["low", "medium", "high", "xhigh"] as const;

const isMuseSparkOpen = (modelId: string) => modelId === "meta/muse-spark-open";

// Host support is model-specific. Add only profiles backed by adapter tests.
export const resolveOpenRouterCapabilities = (
  modelId: string,
  policy: "conservative" | "legacy" = "conservative",
  overrides?: Omit<Partial<ModelCapabilities>, "agentCapabilities"> & {
    agentCapabilities?: Partial<NonNullable<ModelCapabilities["agentCapabilities"]>>;
  }
): ModelCapabilities => {
  const known = isMuseSparkOpen(modelId) || legacyKnownModelIds.includes(modelId);
  const base = {
    ...legacyCapabilities,
    ...(isMuseSparkOpen(modelId) ? {
      // The models API lists tools, tool_choice, response_format, and structured_outputs.
      // It does not list parallel_tool_calls. Reasoning cannot be disabled.
      parallelToolCalls: false,
      reasoningEfforts: [...museSparkOpenEfforts]
    } : {}),
    ...(!known && policy === "conservative" ? {
      tools: false, structuredOutput: false, jsonMode: false, toolChoice: false,
      parallelToolCalls: false, vision: false, reasoning: false,
      agentCapabilities: { ...legacyCapabilities.agentCapabilities!, toolChoiceNone: false },
    } : {}),
  };
  return { ...base, ...overrides, agentCapabilities: { ...base.agentCapabilities!, ...overrides?.agentCapabilities } };
};
