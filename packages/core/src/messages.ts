import { UnsupportedFeatureError } from "./errors.js";
import type { ZodTypeAny } from "zod";
import type {
  AgentCapabilities,
  AgentSupportTier,
  AudioInput,
  ContentPart,
  FinishReason,
  GenerateResult,
  HostedToolDefinition,
  HostedToolClass,
  JsonValue,
  LanguageModel,
  ModelMessage,
  StreamEvent,
  ToolCall,
  ToolDefinition,
  ToolExecutionResult
} from "./types.js";

export const textPart = (text: string): ContentPart => ({ type: "text", text });

export const audioPart = (audio: AudioInput & { format?: string; transcript?: string }): ContentPart => ({
  type: "audio",
  data: audio.data,
  mediaType: audio.mediaType,
  filename: audio.filename,
  format: audio.format,
  transcript: audio.transcript
} as ContentPart);

const normalizeMessageParts = (input: string | ContentPart[]): ContentPart[] => (typeof input === "string" ? [textPart(input)] : input);

export const toolCallPart = (toolCall: ToolCall): ContentPart => ({
  type: "tool-call",
  toolCall
});

export const toolResultPart = (toolResult: ToolExecutionResult): ContentPart => ({
  type: "tool-result",
  toolResult
});

export const providerDataPart = (provider: string, data: JsonValue): ContentPart => ({
  type: "provider-data",
  provider,
  data
});

export const createTextMessage = (role: ModelMessage["role"], text: string): ModelMessage => ({
  role,
  parts: [textPart(text)]
});

export const system = (text: string): ModelMessage => ({
  role: "system",
  parts: [textPart(text)]
});

export const user = (input: string | ContentPart[]): ModelMessage => ({
  role: "user",
  parts: normalizeMessageParts(input)
});

export const assistant = (input: string | ContentPart[]): ModelMessage => ({
  role: "assistant",
  parts: normalizeMessageParts(input)
});

export const getTextFromParts = (parts: ContentPart[]): string =>
  parts
    .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");

export const getTextFromMessages = (messages: ModelMessage[]): string =>
  messages
    .filter((message) => message.role === "assistant")
    .map((message) => getTextFromParts(message.parts))
    .join("");

export const serializeJsonValue = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

export const tool = <TSchema extends ZodTypeAny, TResult extends JsonValue = JsonValue>(
  definition: ToolDefinition<NoInfer<TSchema>, TResult> & { schema: TSchema }
): ToolDefinition<TSchema, TResult> => definition;

const inferHostedToolClass = (definition: Omit<HostedToolDefinition, "kind">): HostedToolClass => {
  const normalizedType = definition.type.toLowerCase();

  if (
    normalizedType.includes("web_search") ||
    normalizedType.includes("web-search") ||
    normalizedType.includes("googlesearch")
  ) {
    return "web-search";
  }

  if (
    normalizedType.includes("web_extractor") ||
    normalizedType.includes("web-extractor") ||
    normalizedType.includes("web_extraction") ||
    normalizedType.includes("web-extraction")
  ) {
    return "web-extraction";
  }

  if (
    normalizedType.includes("file_search") ||
    normalizedType.includes("file-search")
  ) {
    return "file-search";
  }

  if (normalizedType === "mcp" || normalizedType.includes("mcp_toolset") || normalizedType.includes("mcp-toolset")) {
    return normalizedType.includes("toolset") ? "toolset" : "remote-mcp";
  }

  if (
    normalizedType.includes("computer_use") ||
    normalizedType.includes("computer-use")
  ) {
    return "computer-use";
  }

  if (
    normalizedType.includes("codeexecution") ||
    normalizedType.includes("code_execution") ||
    normalizedType.includes("code-execution") ||
    normalizedType.includes("code_interpreter") ||
    normalizedType.includes("code-interpreter")
  ) {
    return "code-execution";
  }

  if (normalizedType === "shell" || normalizedType.includes("shell_call") || normalizedType.includes("shell-call")) {
    return "shell";
  }

  if (
    normalizedType.includes("apply_patch") ||
    normalizedType.includes("apply-patch")
  ) {
    return "apply-patch";
  }

  if (
    normalizedType.includes("tool_search") ||
    normalizedType.includes("tool-search")
  ) {
    return "tool-search";
  }

  if (
    normalizedType === "skill" ||
    normalizedType.includes("skill_tool") ||
    normalizedType.includes("skill-tool")
  ) {
    return "skill";
  }

  return "custom";
};

export const hostedTool = <TTool extends HostedToolDefinition>(definition: Omit<TTool, "kind">): TTool =>
  ({
    kind: "hosted",
    toolClass: inferHostedToolClass(definition),
    ...definition
  }) as TTool;

export const isHostedToolDefinition = (
  toolDefinition: ToolDefinition | HostedToolDefinition
): toolDefinition is HostedToolDefinition => "kind" in toolDefinition && toolDefinition.kind === "hosted";

export const isCallableToolDefinition = (
  toolDefinition: ToolDefinition | HostedToolDefinition
): toolDefinition is ToolDefinition => !isHostedToolDefinition(toolDefinition);

export const getHostedToolClass = (toolDefinition: HostedToolDefinition): HostedToolClass =>
  toolDefinition.toolClass ?? inferHostedToolClass(toolDefinition);

export const isHostedToolClass = (
  toolDefinition: HostedToolDefinition,
  toolClass: HostedToolClass
) => getHostedToolClass(toolDefinition) === toolClass;

const emptyAgentCapabilities: AgentCapabilities = {
  supportTier: "tier-c",
  toolChoiceNone: false,
  approvalRequests: false,
  hostedWebSearch: false,
  hostedFileSearch: false,
  remoteMcp: false,
  computerUse: false,
  codeExecution: false,
  shell: false,
  applyPatch: false,
  toolSearch: false,
  webExtraction: false,
  skills: false,
  programmaticToolCalling: false,
  multiAgent: false,
  toolsets: false
};

export const getAgentCapabilities = (model: LanguageModel): AgentCapabilities => ({
  ...emptyAgentCapabilities,
  ...(model.capabilities.agentCapabilities ?? {})
});

export const getAgentSupportTier = (model: LanguageModel): AgentSupportTier => getAgentCapabilities(model).supportTier;

export const normalizeFinishReason = (reason: string | undefined | null): FinishReason | undefined => {
  if (!reason) {
    return undefined;
  }

  switch (reason.toLowerCase()) {
    case "stop":
    case "end_turn":
      return "stop";
    case "length":
    case "max_tokens":
      return "length";
    case "tool_calls":
    case "tool_use":
      return "tool-calls";
    case "content_filter":
      return "content-filter";
    case "refusal":
      return "refusal";
    case "error":
      return "error";
    default:
      return "unknown";
  }
};

export const resultMessages = (result: GenerateResult): ModelMessage[] => {
  if (result.messages?.length) {
    return result.messages;
  }
  if (result.message) {
    return [result.message];
  }
  if (result.text) {
    return [createTextMessage("assistant", result.text)];
  }
  return [];
};

export const validateMessageParts = (model: LanguageModel, messages: ModelMessage[]) => {
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "image" && !model.capabilities.vision) {
        throw new UnsupportedFeatureError(
          `Model "${model.provider}/${model.modelId}" does not support image inputs.`
        );
      }

      if (part.type === "file" && !model.capabilities.files) {
        throw new UnsupportedFeatureError(
          `Model "${model.provider}/${model.modelId}" does not support file inputs.`
        );
      }

      if (part.type === "tool-call" || part.type === "tool-result") {
        if (!model.capabilities.tools) {
          throw new UnsupportedFeatureError(
            `Model "${model.provider}/${model.modelId}" does not support tool calling.`
          );
        }
      }
    }
  }
};

export const getToolCallsFromEvents = (events: StreamEvent[]): ToolCall[] =>
  events
    .filter((event): event is Extract<StreamEvent, { type: "tool-call" }> => event.type === "tool-call")
    .map((event) => event.toolCall);
