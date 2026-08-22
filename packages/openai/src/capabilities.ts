import type {
  ModelCapabilities,
  RealtimeSessionConfig,
} from "@zhivex-ai/core";

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

export const isOpenAIGpt56Model = (modelId: string) =>
  /^gpt-5\.6(?:$|-(?:sol|terra|luna)(?:-|$)|-\d{4}-\d{2}-\d{2})/.test(
    normalizeModelId(modelId)
  );
const isOpenAIGpt55BaseModel = (modelId: string) =>
  /^gpt-5\.5(?:$|-\d{4}-\d{2}-\d{2})/.test(normalizeModelId(modelId));
const isOpenAIGpt55ProModel = (modelId: string) =>
  /^gpt-5\.5-pro(?:$|-\d{4}-\d{2}-\d{2})/.test(normalizeModelId(modelId));
const isOpenAIGpt54BaseModel = (modelId: string) =>
  /^gpt-5\.4(?:$|-\d{4}-\d{2}-\d{2})/.test(normalizeModelId(modelId));
const isOpenAIGpt54MiniModel = (modelId: string) =>
  /^gpt-5\.4-mini(?:$|-\d{4}-\d{2}-\d{2})/.test(normalizeModelId(modelId));
const isOpenAIGpt54NanoModel = (modelId: string) =>
  /^gpt-5\.4-nano(?:$|-\d{4}-\d{2}-\d{2})/.test(normalizeModelId(modelId));
const isOpenAIGpt54ProModel = (modelId: string) =>
  /^gpt-5\.4-pro(?:$|-\d{4}-\d{2}-\d{2})/.test(normalizeModelId(modelId));

const supportsOpenAIToolSearch = (modelId: string) =>
  isOpenAIGpt56Model(modelId) ||
  isOpenAIGpt55BaseModel(modelId) ||
  isOpenAIGpt54BaseModel(modelId) ||
  isOpenAIGpt54MiniModel(modelId);

const supportsOpenAIComputerUse = supportsOpenAIToolSearch;

export const supportsOpenAIShell = (modelId: string) =>
  isOpenAIGpt56Model(modelId) ||
  isOpenAIGpt55BaseModel(modelId) ||
  isOpenAIGpt55ProModel(modelId) ||
  isOpenAIGpt54BaseModel(modelId) ||
  isOpenAIGpt54MiniModel(modelId) ||
  isOpenAIGpt54NanoModel(modelId) ||
  isOpenAIGpt54ProModel(modelId);

export const supportsOpenAIApplyPatchAndSkills = (modelId: string) =>
  isOpenAIGpt56Model(modelId) ||
  isOpenAIGpt55BaseModel(modelId) ||
  isOpenAIGpt54BaseModel(modelId) ||
  isOpenAIGpt54MiniModel(modelId) ||
  isOpenAIGpt54NanoModel(modelId);

const supportsOpenAIChatAudio = (modelId: string) =>
  /^(?:gpt-audio(?:-|$)|gpt-4o(?:-mini)?-audio-preview(?:-|$))/.test(
    normalizeModelId(modelId)
  );

export const modelCapabilities = (modelId: string): ModelCapabilities => ({
  ...capabilities,
  explicitPromptCaching: isOpenAIGpt56Model(modelId),
  files: isOpenAIGpt56Model(modelId),
  reasoningEfforts: isOpenAIGpt56Model(modelId)
    ? ["none", "low", "medium", "high", "xhigh", "max"]
    : undefined,
  reasoningModes: isOpenAIGpt56Model(modelId) ? ["standard", "pro"] : undefined,
  reasoningContexts: isOpenAIGpt56Model(modelId)
    ? ["auto", "current_turn", "all_turns"]
    : undefined,
  audioInput: supportsOpenAIChatAudio(modelId),
  audioOutput: supportsOpenAIChatAudio(modelId),
  agentCapabilities: {
    ...capabilities.agentCapabilities!,
    computerUse: supportsOpenAIComputerUse(modelId),
    shell: supportsOpenAIShell(modelId),
    applyPatch: supportsOpenAIApplyPatchAndSkills(modelId),
    skills: supportsOpenAIApplyPatchAndSkills(modelId),
    toolSearch: supportsOpenAIToolSearch(modelId),
    programmaticToolCalling: isOpenAIGpt56Model(modelId),
    multiAgent: isOpenAIGpt56Model(modelId),
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

const isOpenAIRealtimeTranslationModel = (modelId: string) =>
  /^gpt-realtime-translate(?:[-@]|$)/.test(modelId);
const isOpenAIRealtimeTranscriptionModel = (modelId: string) =>
  /^gpt-realtime-whisper(?:[-@]|$)/.test(modelId);

export const inferOpenAIRealtimeMode = (
  modelId: string,
  mode?: RealtimeSessionConfig["mode"]
): NonNullable<RealtimeSessionConfig["mode"]> => {
  if (mode) return mode;
  if (isOpenAIRealtimeTranslationModel(modelId)) return "translation";
  if (isOpenAIRealtimeTranscriptionModel(modelId)) return "transcription";
  return "conversation";
};

const isOpenAIRealtimeReasoningModel = (modelId: string) =>
  /^gpt-realtime-2(?:\.1(?:-mini)?)?(?:-\d{4}-\d{2}-\d{2}|@.*)?$/.test(
    modelId
  );

export const openAIRealtimeSupportsImageInput = (modelId: string) =>
  /^(?:gpt-realtime|gpt-realtime-mini|gpt-realtime-1\.5|gpt-realtime-2(?:\.1(?:-mini)?)?)(?:-\d{4}-\d{2}-\d{2}|@.*)?$/.test(
    modelId
  );

export const realtimeCapabilities = (
  modelId: string
): ModelCapabilities => ({
  ...capabilities,
  streaming: false,
  structuredOutput: false,
  jsonMode: false,
  embeddings: false,
  audioInput: true,
  audioOutput: !isOpenAIRealtimeTranscriptionModel(modelId),
  tools:
    !isOpenAIRealtimeTranslationModel(modelId) &&
    !isOpenAIRealtimeTranscriptionModel(modelId),
  toolChoice:
    !isOpenAIRealtimeTranslationModel(modelId) &&
    !isOpenAIRealtimeTranscriptionModel(modelId),
  parallelToolCalls:
    !isOpenAIRealtimeTranslationModel(modelId) &&
    !isOpenAIRealtimeTranscriptionModel(modelId),
  vision: openAIRealtimeSupportsImageInput(modelId),
  reasoning: isOpenAIRealtimeReasoningModel(modelId),
  webSearch: false,
  agentCapabilities: {
    ...capabilities.agentCapabilities!,
    supportTier:
      isOpenAIRealtimeTranslationModel(modelId) ||
      isOpenAIRealtimeTranscriptionModel(modelId)
        ? "tier-c"
        : "tier-a",
    toolChoiceNone:
      !isOpenAIRealtimeTranslationModel(modelId) &&
      !isOpenAIRealtimeTranscriptionModel(modelId),
    approvalRequests:
      !isOpenAIRealtimeTranslationModel(modelId) &&
      !isOpenAIRealtimeTranscriptionModel(modelId),
    hostedWebSearch: false,
    hostedFileSearch: false,
    remoteMcp:
      !isOpenAIRealtimeTranslationModel(modelId) &&
      !isOpenAIRealtimeTranscriptionModel(modelId),
    computerUse: false,
    codeExecution: false,
    shell: false,
    applyPatch: false,
    toolSearch: false,
    skills: false,
    toolsets: false,
  },
  realtime: {
    sessions: true,
    audioInput: true,
    audioOutput: !isOpenAIRealtimeTranscriptionModel(modelId),
    imageInput: openAIRealtimeSupportsImageInput(modelId),
    tools:
      !isOpenAIRealtimeTranslationModel(modelId) &&
      !isOpenAIRealtimeTranscriptionModel(modelId),
    browserTokens: true,
  },
});
