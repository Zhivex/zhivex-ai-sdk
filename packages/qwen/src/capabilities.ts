import type { ModelCapabilities } from "@zhivex-ai/core";

export const capabilities: ModelCapabilities = {
  streaming: true,
  tools: true,
  structuredOutput: true,
  jsonMode: true,
  toolChoice: true,
  parallelToolCalls: false,
  vision: true,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: true,
  reasoning: false,
  webSearch: true,
  agentCapabilities: {
    supportTier: "tier-b",
    toolChoiceNone: true,
    approvalRequests: false,
    hostedWebSearch: true,
    hostedFileSearch: true,
    remoteMcp: true,
    computerUse: false,
    codeExecution: true,
    webExtraction: true,
    toolsets: false
  }
};

export const embeddingCapabilities: ModelCapabilities = {
  streaming: false,
  tools: false,
  structuredOutput: false,
  jsonMode: false,
  toolChoice: false,
  parallelToolCalls: false,
  vision: false,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: true,
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
    toolsets: false
  }
};

export const transcriptionCapabilities: ModelCapabilities = {
  ...embeddingCapabilities,
  audioInput: true
};

export const speechCapabilities: ModelCapabilities = {
  ...embeddingCapabilities,
  audioOutput: true
};

export const imageGenerationCapabilities: ModelCapabilities = {
  ...embeddingCapabilities,
  imageGeneration: true
};

export const videoGenerationCapabilities: ModelCapabilities = {
  ...embeddingCapabilities,
  videoGeneration: true
};

export const realtimeCapabilities: ModelCapabilities = {
  ...capabilities,
  streaming: false,
  structuredOutput: false,
  jsonMode: false,
  toolChoice: false,
  parallelToolCalls: false,
  files: false,
  audioInput: true,
  audioOutput: true,
  embeddings: false,
  reasoning: false,
  webSearch: false,
  agentCapabilities: {
    ...capabilities.agentCapabilities!,
    toolChoiceNone: true,
    hostedWebSearch: false,
    hostedFileSearch: false,
    remoteMcp: false,
    codeExecution: false,
    webExtraction: false
  },
  realtime: {
    sessions: true,
    audioInput: true,
    audioOutput: true,
    imageInput: true,
    tools: true,
    browserTokens: false
  }
};

