import type { ModelCapabilities } from "@zhivex-ai/core/contracts";

export const capabilities: ModelCapabilities = {
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
  embeddings: true,
  reasoning: true,
  webSearch: true,
  agentCapabilities: {
    supportTier: "tier-a",
    durableAgent: true,
    toolChoiceNone: true,
    approvalRequests: true,
    hostedWebSearch: true,
    hostedFileSearch: true,
    remoteMcp: true,
    computerUse: true,
    codeExecution: true,
    shell: true,
    applyPatch: true,
    toolSearch: true,
    skills: true,
    toolsets: false,
  },
};

const normalizeModelId = (modelId: string) => modelId.trim().toLowerCase();

export const isAzureAstraModel = (modelId: string) =>
  /^gpt-6-astra(?:$|-\d{4}-\d{2}-\d{2})/.test(normalizeModelId(modelId));

/** Chat models that reject `max_tokens` and require `max_completion_tokens`. */
export const isAzureReasoningChatModel = (modelId: string) =>
  /^(?:gpt-5|gpt-6|o1|o3|o4|codex-mini)(?:$|[^a-z0-9])/.test(normalizeModelId(modelId));

/** Deployment names that already look like a published model id, so no opaque-name warning is needed. */
export const isKnownAzureModelFamily = (modelId: string) =>
  /^(?:gpt-4o|gpt-4\.1|gpt-5|gpt-6|o1|o3|o4|codex-mini|text-embedding-|whisper|tts-|gpt-4o-mini-tts|gpt-4o-mini-transcribe|gpt-4o-transcribe)/.test(
    normalizeModelId(modelId)
  );

const supportsAzureOpenAIToolSearch = (modelId: string) =>
  isAzureAstraModel(modelId) || /^gpt-5\.4(?:$|-20|-pro)/.test(normalizeModelId(modelId));

const supportsAzureOpenAIComputerUse = (modelId: string) =>
  isAzureAstraModel(modelId) || /^gpt-5\.4(?:$|-20|-pro|-mini)/.test(normalizeModelId(modelId));

export const supportsAzureOpenAIHostedHarnessTools = (modelId: string) =>
  isAzureAstraModel(modelId) || /^gpt-5\.4(?:$|-)/.test(normalizeModelId(modelId));

export const modelCapabilities = (modelId: string): ModelCapabilities => ({
  ...capabilities,
  reasoningEfforts: isAzureAstraModel(modelId) ? ["low", "medium", "high", "xhigh", "max"] : undefined,
  agentCapabilities: {
    ...capabilities.agentCapabilities!,
    computerUse: supportsAzureOpenAIComputerUse(modelId),
    shell: supportsAzureOpenAIHostedHarnessTools(modelId),
    applyPatch: supportsAzureOpenAIHostedHarnessTools(modelId),
    skills: supportsAzureOpenAIHostedHarnessTools(modelId),
    toolSearch: supportsAzureOpenAIToolSearch(modelId),
  },
});

export const transcriptionCapabilities: ModelCapabilities = {
  ...capabilities,
  streaming: false,
  tools: false,
  structuredOutput: false,
  jsonMode: false,
  toolChoice: false,
  parallelToolCalls: false,
  vision: false,
  audioInput: true,
  audioOutput: false,
  embeddings: false,
  reasoning: false,
  webSearch: false,
  agentCapabilities: {
    supportTier: "tier-c",
    toolChoiceNone: false,
    approvalRequests: false,
    hostedWebSearch: false,
    hostedFileSearch: false,
    remoteMcp: false,
    computerUse: false,
    codeExecution: false,
    toolsets: false,
  },
};

export const speechCapabilities: ModelCapabilities = {
  ...transcriptionCapabilities,
  audioInput: false,
  audioOutput: true,
};

export const groundedCapabilities: ModelCapabilities = {
  ...capabilities,
  webSearch: true,
};

export const realtimeCapabilities: ModelCapabilities = {
  ...capabilities,
  streaming: false,
  structuredOutput: false,
  jsonMode: false,
  files: false,
  audioInput: true,
  audioOutput: true,
  embeddings: false,
  reasoning: false,
  webSearch: false,
  agentCapabilities: {
    ...capabilities.agentCapabilities!,
    hostedWebSearch: false,
    hostedFileSearch: false,
    computerUse: false,
    codeExecution: false,
    shell: false,
    applyPatch: false,
    toolSearch: false,
    skills: false,
  },
  realtime: {
    sessions: true,
    audioInput: true,
    audioOutput: true,
    imageInput: true,
    tools: true,
    browserTokens: true,
  },
};
