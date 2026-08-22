import type { ModelCapabilities } from "@zhivex-ai/core";

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

const supportsAzureOpenAIToolSearch = (modelId: string) =>
  /^gpt-5\.4(?:$|-20|-pro)/.test(normalizeModelId(modelId));

const supportsAzureOpenAIComputerUse = (modelId: string) =>
  /^gpt-5\.4(?:$|-20|-pro|-mini)/.test(normalizeModelId(modelId));

export const supportsAzureOpenAIHostedHarnessTools = (modelId: string) =>
  /^gpt-5\.4(?:$|-)/.test(normalizeModelId(modelId));

export const modelCapabilities = (modelId: string): ModelCapabilities => ({
  ...capabilities,
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
