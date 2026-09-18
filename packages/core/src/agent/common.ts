import {
  getAgentApprovalRequests
} from "../agent-approval.js";
import {
  normalizeAgentRunState
} from "../agent-state.js";
import {
  ProviderToolCallError,
  ToolNotRegisteredError,
  UnsupportedFeatureError
} from "../errors.js";
import {
  getGenerateTextStepTiming
} from "../generate-text.js";
import {
  createSecureId
} from "#secure-id";
import {
  createStructuredOutputPrompt
} from "../structured-output-prompt.js";
import type {
  AgentApprovalRequest,
  AgentDefinition,
  AgentRunError,
  AgentRunOutput,
  AgentRunState,
  AgentStep,
  AgentStepRequest,
  AgentStepResponse,
  AgentStatus,
  GenerateTextStep,
  JsonValue,
  ModelGenerateInput,
  ModelMessage,
  ProviderOptions,
  ToolExecutionResult
} from "../types.js";

export const randomId = createSecureId;

export const joinInstructions = (...parts: Array<string | undefined>): string | undefined => {
  const content = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  return content.length ? content.join("\n\n") : undefined;
};

export const resolveAgentOutputMode = (
  agent: AgentDefinition
): "native" | "prompted" | undefined => {
  if (!agent.outputSchema) {
    return undefined;
  }
  const requested = agent.outputMode ?? "auto";
  if (requested === "native" && !agent.model.capabilities.structuredOutput) {
    throw new UnsupportedFeatureError(
      `Model "${agent.model.provider}/${agent.model.modelId}" does not support native structured output.`
    );
  }
  return requested === "auto"
    ? agent.model.capabilities.structuredOutput
      ? "native"
      : "prompted"
    : requested;
};

export const promptedOutputInstruction = (agent: AgentDefinition): string | undefined =>
  agent.outputSchema && resolveAgentOutputMode(agent) === "prompted"
    ? createStructuredOutputPrompt(agent.outputSchema, {
        name: agent.outputName,
        description: agent.outputDescription
      })
    : undefined;

export const hasToolCalls = (messages: ModelMessage[]): boolean =>
  messages.some((message) => message.parts.some((part) => part.type === "tool-call"));

export const snapshotRequest = (
  request: ModelGenerateInput,
  messageOffset = 0,
  messages: ModelMessage[] = request.messages
): AgentStepRequest => ({
  messageOffset,
  messages,
  toolChoice: request.toolChoice,
  toolExecution: request.toolExecution,
  temperature: request.temperature,
  maxTokens: request.maxTokens,
  reasoning: request.reasoning,
  providerOptions: request.providerOptions as ProviderOptions | undefined,
  timeoutMs: request.timeoutMs,
  maxRetries: request.maxRetries,
  retryBackoffMs: request.retryBackoffMs
});

export const snapshotResponse = (response: GenerateTextStep["response"]): AgentStepResponse => ({
  messages: response.messages ?? (response.message ? [response.message] : []),
  text: response.text,
  finishReason: response.finishReason,
  providerFinishReason: response.providerFinishReason,
  usage: response.usage
});

const countToolCalls = (messages: ModelMessage[]): number =>
  messages.reduce(
    (total, message) => total + message.parts.filter((part) => part.type === "tool-call").length,
    0
  );

export const messagePrefixLength = (
  prefix: ModelMessage[],
  messages: ModelMessage[]
): number => {
  if (prefix.length > messages.length) {
    return 0;
  }
  for (let index = 0; index < prefix.length; index += 1) {
    if (JSON.stringify(prefix[index]) !== JSON.stringify(messages[index])) {
      return 0;
    }
  }
  return prefix.length;
};

export const mapSteps = (steps: GenerateTextStep[], offset: number, toolResults: ToolExecutionResult[]): AgentStep[] => {
  let toolResultCursor = 0;
  let previousMessages: ModelMessage[] = [];

  return steps.map((step, index) => {
    const response = snapshotResponse(step.response);
    const toolCallCount = countToolCalls(response.messages);
    const stepToolResults = toolResults.slice(toolResultCursor, toolResultCursor + toolCallCount);
    toolResultCursor += toolCallCount;
    const timing = getGenerateTextStepTiming(step.request);
    const finishedAt = timing?.finishedAt ?? Date.now();
    const messageOffset = index === 0 ? 0 : messagePrefixLength(previousMessages, step.request.messages);
    const incrementalMessages = step.request.messages.slice(messageOffset);
    previousMessages = step.request.messages;

    return {
      index: offset + index + 1,
      status: "completed",
      startedAt: timing?.startedAt ?? finishedAt,
      finishedAt,
      request: snapshotRequest(step.request, messageOffset, incrementalMessages),
      response,
      toolResults: stepToolResults
    };
  });
};

export const cloneMetadata = (...values: Array<Record<string, JsonValue> | undefined>) => {
  const merged = Object.assign({}, ...values.filter(Boolean));
  return Object.keys(merged).length ? merged : undefined;
};

export const toOutput = <TOutput = unknown>(state: AgentRunState): AgentRunOutput<TOutput> => ({
  status: state.status,
  taskOutcome: state.taskOutcome,
  outputText: state.outputText,
  finalOutput:
    state.status === "completed" && state.finalOutput !== undefined
      ? state.finalOutput as TOutput
      : undefined,
  finishReason: state.finishReason,
  providerFinishReason: state.providerFinishReason,
  usage: state.usage,
  messages: state.messages,
  steps: state.steps,
  toolResults: state.toolResults,
  state,
  error: state.error
});

export const normalizeApprovalStatus = (status: AgentStatus): AgentStatus =>
  status === "suspended" ? "waiting_approval" : status;

export const cloneState = (state: AgentRunState): AgentRunState =>
  JSON.parse(JSON.stringify(normalizeAgentRunState(state))) as AgentRunState;

export const countToolCallsInSteps = (steps: AgentStep[]): number =>
  steps.reduce((total, step) => total + countToolCalls(step.response?.messages ?? []), 0);

export const countToolErrors = (toolResults: ToolExecutionResult[]): number =>
  toolResults.filter((result) => result.isError).length;

export const approvalsFromEvents = (messages: ModelMessage[]): AgentApprovalRequest[] => getAgentApprovalRequests(messages);

const toAgentRunError = (error: unknown): AgentRunError => {
  if (error instanceof ToolNotRegisteredError) {
    return { message: error.message, diagnosticCode: error.code };
  }
  if (error instanceof ProviderToolCallError) {
    return {
      message: error.message,
      diagnosticCode: error.diagnosticCode,
      category: error.category,
      provider: error.provider,
      ...(error.transport ? { transport: error.transport } : {}),
      reason: error.reason,
      retryable: error.retryable,
      effectsPossible: error.effectsPossible
    };
  }

  return {
    message: error instanceof Error ? error.message : String(error)
  };
};

export const createFailedState = (state: AgentRunState, error: unknown): AgentRunState => ({
  ...state,
  status: "failed",
  error: toAgentRunError(error),
  updatedAt: Date.now()
});

export const createTerminalState = (
  state: AgentRunState,
  status: Extract<AgentStatus, "cancel_requested" | "timed_out">,
  message: string
): AgentRunState => ({
  ...state,
  status,
  error: {
    message
  },
  cancellationReason: status === "cancel_requested" ? message : state.cancellationReason,
  cancelledAt: status === "cancel_requested" ? Date.now() : state.cancelledAt,
  updatedAt: Date.now()
});
