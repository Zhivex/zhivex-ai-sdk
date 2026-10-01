import { UnsupportedFeatureError } from "@zhivex-ai/core/provider";
import type {
  ModelCapabilities,
  RealtimeSessionConfig,
  ModelGenerateInput,
} from "@zhivex-ai/core/contracts";

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
  /^gpt-5\.6(?:-(?:sol|terra|luna))?(?:-\d{4}-\d{2}-\d{2})?$/.test(
    normalizeModelId(modelId)
  );
export const isOpenAIAstraModel = (modelId: string) =>
  /^gpt-6-astra(?:-\d{4}-\d{2}-\d{2})?$/.test(normalizeModelId(modelId));

export const isOpenAISolLunaModel = (modelId: string) =>
  /^gpt-6-(?:sol|luna)(?:$|-\d{4}-\d{2}-\d{2}$)/.test(normalizeModelId(modelId));

export const supportsOpenAIModernResponses = (modelId: string) =>
  isOpenAIGpt56Model(modelId) || isOpenAIAstraModel(modelId) || isOpenAISolLunaModel(modelId);

const isOpenAIGpt55BaseModel = (modelId: string) =>
  /^gpt-5\.5(?:-\d{4}-\d{2}-\d{2})?$/.test(normalizeModelId(modelId));
const isOpenAIGpt55ProModel = (modelId: string) =>
  /^gpt-5\.5-pro(?:-\d{4}-\d{2}-\d{2})?$/.test(normalizeModelId(modelId));
const isOpenAIGpt54BaseModel = (modelId: string) =>
  /^gpt-5\.4(?:-\d{4}-\d{2}-\d{2})?$/.test(normalizeModelId(modelId));
const isOpenAIGpt54MiniModel = (modelId: string) =>
  /^gpt-5\.4-mini(?:-\d{4}-\d{2}-\d{2})?$/.test(normalizeModelId(modelId));
const isOpenAIGpt54NanoModel = (modelId: string) =>
  /^gpt-5\.4-nano(?:-\d{4}-\d{2}-\d{2})?$/.test(normalizeModelId(modelId));
const isOpenAIGpt54ProModel = (modelId: string) =>
  /^gpt-5\.4-pro(?:-\d{4}-\d{2}-\d{2})?$/.test(normalizeModelId(modelId));

const supportsOpenAIToolSearch = (modelId: string) =>
  supportsOpenAIModernResponses(modelId) ||
  isOpenAIGpt55BaseModel(modelId) ||
  isOpenAIGpt54BaseModel(modelId) ||
  isOpenAIGpt54MiniModel(modelId);

const supportsOpenAIComputerUse = supportsOpenAIToolSearch;

export const supportsOpenAIShell = (modelId: string) =>
  supportsOpenAIModernResponses(modelId) ||
  isOpenAIGpt55BaseModel(modelId) ||
  isOpenAIGpt55ProModel(modelId) ||
  isOpenAIGpt54BaseModel(modelId) ||
  isOpenAIGpt54MiniModel(modelId) ||
  isOpenAIGpt54NanoModel(modelId) ||
  isOpenAIGpt54ProModel(modelId);

export const supportsOpenAIApplyPatchAndSkills = (modelId: string) =>
  supportsOpenAIModernResponses(modelId) ||
  isOpenAIGpt55BaseModel(modelId) ||
  isOpenAIGpt54BaseModel(modelId) ||
  isOpenAIGpt54MiniModel(modelId) ||
  isOpenAIGpt54NanoModel(modelId);

const supportsOpenAIChatAudio = (modelId: string) =>
  /^(?:gpt-audio(?:-|$)|gpt-4o(?:-mini)?-audio-preview(?:-|$))/.test(
    normalizeModelId(modelId)
  );

export const isKnownOpenAIChatModel = (modelId: string) =>
  ["gpt-4-0613", "gpt-4-1106-preview", "gpt-4-0125-preview", "gpt-3.5-turbo-0125", "gpt-3.5-turbo-1106"].includes(normalizeModelId(modelId)) ||
  /^(?:gpt-(?:3\.5-turbo|4(?:o|\.1|\.5|-turbo)?(?:-mini|-nano)?|5(?:\.[1-6])?(?:-sol|-terra|-luna|-mini|-nano|-pro|-chat-latest)?|6-(?:sol|luna|astra))|o[134](?:-mini|-pro)?)(?:$|-\d{4}-\d{2}-\d{2}$|-preview$)/.test(normalizeModelId(modelId)) || supportsOpenAIChatAudio(modelId);

export const conservativeCapabilities: ModelCapabilities = {
  streaming: true,
  explicitPromptCaching: false,
  tools: false,
  structuredOutput: false,
  jsonMode: false,
  toolChoice: false,
  parallelToolCalls: false,
  vision: false,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
  reasoning: false,
  webSearch: false,
  agentCapabilities: {
    supportTier: "tier-c", toolChoiceNone: false, approvalRequests: false,
    hostedWebSearch: false, hostedFileSearch: false, remoteMcp: false,
    computerUse: false, codeExecution: false, toolsets: false,
  },
};

export const modelCapabilities = (modelId: string, unknownPolicy: "conservative" | "legacy" = "conservative"): ModelCapabilities =>
  !isKnownOpenAIChatModel(modelId) && unknownPolicy === "conservative"
  ? { ...conservativeCapabilities, agentCapabilities: { ...conservativeCapabilities.agentCapabilities! } }
  : ({
  ...capabilities,
  explicitPromptCaching: supportsOpenAIModernResponses(modelId),
  files: supportsOpenAIModernResponses(modelId),
  reasoningEfforts: resolveOpenAIModelProfile(modelId).reasoningEfforts ? [...resolveOpenAIModelProfile(modelId).reasoningEfforts!] : undefined,
  reasoningModes: supportsOpenAIModernResponses(modelId) ? ["standard", "pro"] : undefined,
  reasoningContexts: supportsOpenAIModernResponses(modelId)
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
    programmaticToolCalling: supportsOpenAIModernResponses(modelId),
    multiAgent: supportsOpenAIModernResponses(modelId),
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

/** Family policy is the single input to metadata, validation and default transport selection. */
export const resolveOpenAIModelProfile = (modelId: string) => {
  const astra = isOpenAIAstraModel(modelId);
  const solLuna = isOpenAISolLunaModel(modelId);
  const modern = supportsOpenAIModernResponses(modelId);
  return {
    label: astra ? "GPT-6 Astra" : "GPT-6 Sol/Luna",
    defaultApi: modern ? "responses" : "chat",
    modern,
    reasoningEfforts: modern ? (astra ? ["low", "medium", "high", "xhigh", "max"] as const : ["none", "low", "medium", "high", "xhigh", "max"] as const) : undefined,
    sampling: astra ? "unsupported" : solLuna ? "effort-none" : "allowed",
    toolsRequireResponses: astra ? "always" : solLuna ? "unless-effort-none" : "never",
  };
};

export const assertOpenAIModelRequestSupported = (
  modelId: string,
  input: ModelGenerateInput,
  options: { apiMode?: string; bodyOptions: Record<string, any> }
) => {
  const profile = resolveOpenAIModelProfile(modelId);
  const raw = options.bodyOptions;
  const effort = input.reasoning?.effort ?? raw.reasoning?.effort ?? raw.reasoning_effort;
  // Existing GPT-5.6 behavior is preserved; restrictive policies apply to GPT-6.
  if (profile.sampling === "allowed") return;
  if (effort !== undefined && profile.reasoningEfforts && !profile.reasoningEfforts.some(value => value === String(effort))) {
    throw new UnsupportedFeatureError(`${profile.label} does not support reasoning effort "${effort}".`);
  }
  const restricted = profile.sampling === "unsupported" || effort !== "none";
  const hasSampling = input.temperature !== undefined || raw.temperature !== undefined || raw.top_p !== undefined || raw.top_logprobs !== undefined ||
    (options.apiMode === "chat" && raw.logprobs !== undefined) || raw.include?.includes("message.output_text.logprobs");
  if (restricted && hasSampling) {
    throw new UnsupportedFeatureError(profile.sampling === "unsupported"
      ? `${profile.label} does not support the requested sampling or logprobs controls.`
      : `${profile.label} sampling and logprobs controls require reasoning effort "none".`);
  }
  if (options.apiMode === "chat" && Object.keys(input.tools ?? {}).length &&
    (profile.toolsRequireResponses === "always" || (profile.toolsRequireResponses === "unless-effort-none" && effort !== "none"))) {
    throw new UnsupportedFeatureError(profile.toolsRequireResponses === "always"
      ? `${profile.label} tool calling requires the Responses API.`
      : `${profile.label} tool calling with reasoning requires the Responses API; Chat Completions requires effort "none".`);
  }
};
