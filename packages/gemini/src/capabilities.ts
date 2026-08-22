import type { ModelCapabilities } from "@zhivex-ai/core";

export const isGeminiLiveTranslateModel = (modelId: string) => /^gemini-3\.5-live-translate(?:-preview)?$/i.test(modelId.trim());

export const capabilities: ModelCapabilities = {
  streaming: true,
  tools: true,
  structuredOutput: true,
  jsonMode: true,
  toolChoice: true,
  parallelToolCalls: false,
  vision: true,
  files: true,
  audioInput: true,
  audioOutput: false,
  embeddings: true,
  fileSearch: true,
  urlContext: true,
  contextCaching: true,
  batch: true,
  interactions: true,
  rawPrediction: true,
  computerUse: true,
  reasoning: true,
  webSearch: true,
  agentCapabilities: {
    supportTier: "tier-b",
    toolChoiceNone: true,
    approvalRequests: false,
    hostedWebSearch: true,
    hostedFileSearch: true,
    remoteMcp: false,
    computerUse: true,
    codeExecution: true,
    toolsets: false
  }
};

export const transcriptionCapabilities: ModelCapabilities = {
  ...capabilities,
  streaming: false,
  tools: false,
  structuredOutput: false,
  jsonMode: false,
  toolChoice: false,
  parallelToolCalls: false,
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
    toolsets: false
  }
};

export const speechCapabilities: ModelCapabilities = {
  ...transcriptionCapabilities,
  streaming: true,
  audioInput: false,
  audioOutput: true
};

export const groundedCapabilities: ModelCapabilities = {
  ...capabilities,
  webSearch: true
};

export const imageGenerationCapabilities: ModelCapabilities = {
  ...capabilities,
  streaming: false,
  tools: false,
  structuredOutput: false,
  jsonMode: false,
  toolChoice: false,
  parallelToolCalls: false,
  embeddings: false,
  imageGeneration: true,
  videoGeneration: false,
  musicGeneration: false,
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

export const videoGenerationCapabilities: ModelCapabilities = {
  ...capabilities,
  streaming: false,
  tools: false,
  structuredOutput: false,
  jsonMode: false,
  toolChoice: false,
  parallelToolCalls: false,
  vision: false,
  embeddings: false,
  imageGeneration: false,
  videoGeneration: true,
  musicGeneration: false,
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

export const musicGenerationCapabilities: ModelCapabilities = {
  ...capabilities,
  streaming: false,
  tools: false,
  structuredOutput: false,
  jsonMode: false,
  toolChoice: false,
  parallelToolCalls: false,
  embeddings: false,
  imageGeneration: false,
  videoGeneration: false,
  musicGeneration: true,
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

export const realtimeCapabilities = (modelId: string): ModelCapabilities => {
  const translation = isGeminiLiveTranslateModel(modelId);
  return {
    ...capabilities,
    streaming: false,
    tools: !translation,
    structuredOutput: false,
    jsonMode: false,
    toolChoice: false,
    parallelToolCalls: false,
    vision: !translation,
    files: false,
    audioInput: true,
    audioOutput: true,
    embeddings: false,
    fileSearch: false,
    urlContext: false,
    contextCaching: false,
    batch: false,
    interactions: false,
    rawPrediction: false,
    computerUse: false,
    reasoning: !translation,
    webSearch: !translation,
    agentCapabilities: {
      ...capabilities.agentCapabilities!,
      toolChoiceNone: !translation,
      hostedWebSearch: !translation,
      hostedFileSearch: false,
      remoteMcp: false,
      computerUse: false,
      codeExecution: false
    },
    realtime: {
      sessions: true,
      audioInput: true,
      audioOutput: true,
      imageInput: !translation,
      tools: !translation,
      browserTokens: true
    }
  };
};

