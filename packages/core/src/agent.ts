import { createHash } from "node:crypto";

import { createAgentApprovalMessage, getAgentApprovalRequests } from "./agent-approval.js";
import { createAgentHandoffMessage } from "./agent-handoff-contracts.js";
import { createAgentExecutionEnvironmentBinding, fingerprintAgentHarness } from "./agent-harness.js";
import { AGENT_RUN_STATE_SCHEMA_VERSION, normalizeAgentRunState } from "./agent-state.js";
import { BoundedReplayBroadcast } from "./bounded-broadcast.js";
import { ConflictError, GuardrailTriggeredError, UnsupportedFeatureError, ValidationError } from "./errors.js";
import { aggregateTokenUsage, generateText, getGenerateTextStepTiming, normalizeMessages, streamText } from "./generate-text.js";
import { createTextMessage, isCallableToolDefinition, serializeJsonValue } from "./messages.js";
import { createMergedAbortSignal } from "./runtime.js";
import { evaluateAgentBudgetPreflight, getAgentBudgetStatus } from "./safety-policy.js";
import { createSecureId } from "#secure-id";
import { createStructuredOutputPrompt } from "./structured-output-prompt.js";
import { ToolExecutionSuspendedError } from "./tool-execution-suspension.js";
import { toToolSet } from "./tool-registry.js";
import { z } from "zod";
import type {
  AgentChildRun,
  AgentCompactionOptions,
  AgentCompactionReason,
  AgentCompactionRecord,
  AgentApprovalRequest,
  AgentApprovalResolution,
  AgentApprovalResponse,
  AgentDefinition,
  AgentExecutionEnvironment,
  AgentExecutionEnvironmentBinding,
  AgentExecutionEnvironmentSession,
  AgentGroupMember,
  AgentGroupRunInput,
  AgentGroupRunOutput,
  AgentGuardrailTrigger,
  AgentInputGuardrail,
  AgentOutputGuardrail,
  AgentRunCancellationOptions,
  AgentRunInput,
  AgentRunOutput,
  AgentRunState,
  AgentRunPolicy,
  AgentRunStore,
  AgentRunTreeCancellationResult,
  AgentStep,
  AgentStepRequest,
  AgentStepResponse,
  AgentStatus,
  AgentStreamEvent,
  AgentStreamResult,
  AgentTelemetryEvent,
  AgentToolCallJournalEntry,
  CreateSubAgentToolOptions,
  GenerateTextOptions,
  GenerateTextOutput,
  GenerateTextStep,
  JsonValue,
  LanguageModel,
  ModelGenerateInput,
  ModelMessage,
  PrepareSubagentsForAgentOptions,
  ProviderOptions,
  SubAgentToolInput,
  SubAgentToolOutput,
  ToolApprovalDecision,
  ToolApprovalEvent,
  ToolDefinition,
  ToolExecutionContext,
  ToolInputGuardrail,
  ToolExecutionResult
} from "./types.js";

const randomId = createSecureId;
const AGENT_GROUP_FAIL_FAST_ABORT_MESSAGE = "Agent group member aborted after fail-fast.";
const DEFAULT_AGENT_LEASE_TTL_MS = 30_000;
const DEFAULT_AGENT_CANCELLATION_POLL_MS = 1_000;
const DEFAULT_AGENT_MAX_STATE_BYTES = 4 * 1024 * 1024;

class AgentPolicyTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Agent run timed out after ${timeoutMs}ms.`);
    this.name = "AgentPolicyTimeoutError";
  }
}

const joinInstructions = (...parts: Array<string | undefined>): string | undefined => {
  const content = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  return content.length ? content.join("\n\n") : undefined;
};

const resolveAgentOutputMode = (
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

const promptedOutputInstruction = (agent: AgentDefinition): string | undefined =>
  agent.outputSchema && resolveAgentOutputMode(agent) === "prompted"
    ? createStructuredOutputPrompt(agent.outputSchema, {
        name: agent.outputName,
        description: agent.outputDescription
      })
    : undefined;

const hasToolCalls = (messages: ModelMessage[]): boolean =>
  messages.some((message) => message.parts.some((part) => part.type === "tool-call"));

const snapshotRequest = (
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

const snapshotResponse = (response: GenerateTextStep["response"]): AgentStepResponse => ({
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

const messagePrefixLength = (
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

const mapSteps = (steps: GenerateTextStep[], offset: number, toolResults: ToolExecutionResult[]): AgentStep[] => {
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

const cloneMetadata = (...values: Array<Record<string, JsonValue> | undefined>) => {
  const merged = Object.assign({}, ...values.filter(Boolean));
  return Object.keys(merged).length ? merged : undefined;
};

const toOutput = <TOutput = unknown>(state: AgentRunState): AgentRunOutput<TOutput> => ({
  status: state.status,
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

const normalizeApprovalStatus = (status: AgentStatus): AgentStatus =>
  status === "suspended" ? "waiting_approval" : status;

const cloneState = (state: AgentRunState): AgentRunState =>
  JSON.parse(JSON.stringify(normalizeAgentRunState(state))) as AgentRunState;

const createBaseState = (
  provider: string,
  modelId: string,
  initialMessages: ModelMessage[],
  maxSteps: number,
  metadata: Record<string, JsonValue> | undefined,
  agentId: string | undefined,
  runId: string,
  handoff: AgentRunInput["handoff"],
  parentRunId: string | undefined,
  idempotencyKey: string | undefined,
  scope: AgentRunInput["scope"],
  outputMode: "native" | "prompted" | undefined,
  harness: AgentDefinition["harness"],
  executionEnvironment: AgentExecutionEnvironmentBinding | undefined
): AgentRunState => {
  const startedAt = Date.now();

  return {
    schemaVersion: AGENT_RUN_STATE_SCHEMA_VERSION,
    revision: 0,
    runId,
    scope,
    idempotencyKey,
    agentId,
    parentRunId: parentRunId ?? handoff?.fromRunId,
    provider,
    modelId,
    harness,
    executionEnvironment,
    status: "running",
    messages: initialMessages,
    steps: [],
    toolResults: [],
    currentStep: 0,
    maxSteps,
    outputText: "",
    outputMode,
    pendingApprovals: [],
    approvalHistory: [],
    compactions: [],
    metadata,
    handoff,
    startedAt,
    updatedAt: startedAt
  };
};

const ensureValidStateInput = (input: AgentRunInput) => {
  if (input.approvals?.length && !input.state) {
    throw new ValidationError('The "approvals" option requires an existing agent "state".');
  }

  if (!input.state) {
    return;
  }

  if (input.prompt !== undefined || input.messages !== undefined || input.system !== undefined || input.handoff !== undefined) {
    throw new ValidationError('Pass either "state" or a fresh "prompt"/"messages" input, but not both.');
  }

  const stateScope = input.state?.scope;
  const inputScope = input.scope;
  if (
    stateScope &&
    inputScope &&
    (stateScope.tenantId !== inputScope.tenantId ||
      stateScope.userId !== inputScope.userId ||
      stateScope.namespace !== inputScope.namespace)
  ) {
    throw new ValidationError('The provided agent state belongs to a different tenant/user scope.');
  }
};

const ensureValidIdempotencyInput = (input: AgentRunInput, store: AgentRunStore | undefined) => {
  if (!input.idempotencyKey) {
    return;
  }

  if (!store) {
    throw new ValidationError('The "idempotencyKey" option requires an agent run "store".');
  }

  if (!store.claimIdempotencyKey) {
    throw new ValidationError('The agent run "store" must implement "claimIdempotencyKey()" to use "idempotencyKey" safely.');
  }
};

const ensureValidScope = (scope: AgentRunInput["scope"]) => {
  if (!scope) return;
  if (typeof scope.tenantId !== "string" || scope.tenantId.length === 0) {
    throw new ValidationError('Agent scope "tenantId" must be a non-empty string.');
  }
  for (const field of ["userId", "namespace"] as const) {
    if (scope[field] !== undefined && (typeof scope[field] !== "string" || scope[field]!.length === 0)) {
      throw new ValidationError(`Agent scope "${field}" must be a non-empty string when provided.`);
    }
  }
};

const invokeOperationalHook = async <TModel extends LanguageModel, TResult>(
  agent: AgentDefinition<TModel>,
  source: "telemetry" | "memory",
  operation: string,
  runId: string | undefined,
  callback: (() => TResult | Promise<TResult>) | undefined,
  fallback: TResult
): Promise<TResult> => {
  if (!callback) {
    return fallback;
  }

  try {
    return await callback();
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    try {
      await agent.hookFailurePolicy?.onError?.({
        source,
        operation,
        runId,
        error: normalizedError
      });
    } catch {
      // Reporting an observer failure must never recursively fail the run.
    }
    if (agent.hookFailurePolicy?.[source] === "fail") {
      throw normalizedError;
    }
    return fallback;
  }
};

const injectContextMessages = (messages: ModelMessage[], extraMessages: ModelMessage[]): ModelMessage[] => {
  if (!extraMessages.length) {
    return messages;
  }

  if (messages[0]?.role === "system") {
    return [messages[0], ...extraMessages, ...messages.slice(1)];
  }

  return [...extraMessages, ...messages];
};

const prepareFreshMessages = async <TModel extends AgentDefinition["model"]>(
  agent: AgentDefinition<TModel>,
  input: AgentRunInput<TModel>,
  runId: string
): Promise<{ messages: ModelMessage[]; memoryMessages: ModelMessage[] }> => {
  let messages = normalizeMessages({
    prompt: input.prompt,
    messages: input.messages,
    system: joinInstructions(agent.instructions, input.system, promptedOutputInstruction(agent))
  });

  const handoffMessages = input.handoff
    ? [createAgentHandoffMessage(input.handoff), ...input.handoff.contextMessages.filter((message) => message.role !== "system")]
    : [];
  messages = injectContextMessages(messages, handoffMessages);

  const memoryMessages = await invokeOperationalHook(
    agent,
    "memory",
    "load",
    runId,
    agent.memory
      ? () => agent.memory!.load({
        runId,
        agentId: agent.id,
        scope: input.scope ?? input.handoff?.scope,
        metadata: cloneMetadata(agent.metadata, input.metadata)
      })
      : undefined,
    [] as ModelMessage[]
  );

  messages = injectContextMessages(messages, memoryMessages);

  return {
    messages,
    memoryMessages
  };
};

const localApprovalResolutionPayload = (
  inputDigest: string,
  approve: boolean,
  reason?: string
): string => JSON.stringify({
  inputDigest,
  approve,
  reason: reason ?? null
});

const approvalKey = (provider: string, requestId: string) => `${provider}\0${requestId}`;

const applyApprovalResponses = async (
  messages: ModelMessage[],
  approvals: AgentApprovalResponse[] | undefined,
  pendingApprovals: AgentRunState["pendingApprovals"],
  approvalHistory: AgentRunState["approvalHistory"] = [],
  signer?: AgentDefinition["toolApprovalSigner"]
) => {
  if (!approvals?.length) {
    return {
      messages,
      pendingApprovals,
      approvalHistory
    };
  }

  const pendingById = new Map(
    pendingApprovals.map((approval) => [approvalKey(approval.provider, approval.id), approval])
  );
  for (const approval of approvals) {
    const pending = pendingById.get(approvalKey(approval.provider, approval.approvalRequestId));
    if (!pending) {
      throw new ValidationError(
        `Unknown approval request "${approval.approvalRequestId}" for provider "${approval.provider}".`
      );
    }
  }

  const providerApprovals = approvals.filter((approval) => {
    const pending = pendingById.get(approvalKey(approval.provider, approval.approvalRequestId));
    return pending?.kind === undefined || pending.kind === "provider";
  });
  const localResolutions: AgentApprovalResolution[] = [];
  const subagentResolutions: AgentApprovalResolution[] = [];
  for (const approval of approvals) {
    const pending = pendingById.get(approvalKey(approval.provider, approval.approvalRequestId));
    if (!pending) {
      continue;
    }
    if (pending.kind === "subagent") {
      subagentResolutions.push({
        requestId: pending.id,
        kind: "subagent",
        provider: pending.provider,
        approve: approval.approve,
        reason: approval.reason,
        toolCallId: pending.toolCallId,
        childRunId: pending.childRunId,
        childAgentId: pending.childAgentId,
        childApprovalRequestId: pending.childApprovalRequestId,
        resolvedAt: Date.now()
      });
      continue;
    }
    if (pending.kind !== "local-tool") {
      continue;
    }
    if (signer) {
      if (!pending.inputDigest || !pending.signature) {
        throw new ValidationError(`Approval request "${pending.id}" is missing its required signature.`);
      }
      const requestSignatureValid = signer.verify
        ? await signer.verify(pending.inputDigest, pending.signature)
        : (await signer.sign(pending.inputDigest)) === pending.signature;
      if (!requestSignatureValid) {
        throw new ValidationError(`Approval request "${pending.id}" has an invalid signature.`);
      }
    }
    const resolutionSignature =
      signer && pending.inputDigest
        ? await signer.sign(
            localApprovalResolutionPayload(
              pending.inputDigest,
              approval.approve,
              approval.reason
            )
          )
        : undefined;
    localResolutions.push({
      requestId: pending.id,
      kind: "local-tool",
      provider: pending.provider,
      approve: approval.approve,
      reason: approval.reason,
      toolCallId: pending.toolCallId,
      step: pending.step,
      inputDigest: pending.inputDigest,
      toolVersion: pending.toolVersion,
      signature: resolutionSignature,
      resolvedAt: Date.now()
    });
  }

  return {
    messages: providerApprovals.length
      ? [...messages, createAgentApprovalMessage(providerApprovals)]
      : messages,
    pendingApprovals: pendingApprovals.filter(
      (pending) => !approvals.some(
        (approval) =>
          approval.approvalRequestId === pending.id &&
          approval.provider === pending.provider
      )
    ),
    approvalHistory: [
      ...approvalHistory.filter(
        (existing) =>
          !localResolutions.some(
            (resolution) =>
              resolution.requestId === existing.requestId &&
              resolution.provider === existing.provider
          ) &&
          !subagentResolutions.some(
            (resolution) =>
              resolution.requestId === existing.requestId &&
              resolution.provider === existing.provider
          )
      ),
      ...localResolutions,
      ...subagentResolutions
    ]
  };
};

const finalizeState = <TOutput>(
  agent: AgentDefinition<LanguageModel, any, TOutput>,
  state: AgentRunState,
  result: GenerateTextOutput,
  newSteps: AgentStep[],
  newToolResults: ToolExecutionResult[]
): AgentRunOutput<TOutput> => {
  const nextCurrentStep = state.currentStep + newSteps.length;
  const exhausted = nextCurrentStep >= state.maxSteps;
  const lastStep = newSteps.at(-1);
  const unresolvedToolCalls = lastStep?.response ? hasToolCalls(lastStep.response.messages) : false;
  const pendingApprovals = [
    ...(result.approvalRequests ?? []),
    ...getAgentApprovalRequests(newSteps.flatMap((step) => step.response?.messages ?? []))
  ];

  if (pendingApprovals.length) {
    state.status = "waiting_approval";
    state.error = undefined;
    if (lastStep) {
      lastStep.status = "waiting_approval";
    }
  } else if (exhausted && unresolvedToolCalls) {
    state.status = "failed";
    state.error = {
      message: "Agent exhausted maxSteps before reaching a terminal response."
    };
    if (lastStep) {
      lastStep.status = "failed";
      lastStep.error = state.error;
    }
  } else {
    state.status = "completed";
    state.error = undefined;
  }

  state.messages = result.messages;
  state.steps = [...state.steps, ...newSteps];
  state.toolResults = [...state.toolResults, ...newToolResults];
  state.currentStep = nextCurrentStep;
  state.outputText = result.text;
  if (state.status === "completed") {
    const terminalText = result.steps.at(-1)?.response.text ?? result.text;
    if (agent.outputSchema) {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(terminalText);
      } catch (error) {
        throw new ValidationError("Agent final output is not valid JSON.", { cause: error });
      }
      const parsedOutput = agent.outputSchema.safeParse(parsedJson);
      if (!parsedOutput.success) {
        throw new ValidationError(`Agent final output validation failed: ${parsedOutput.error.message}`);
      }
      state.finalOutput = serializeJsonValue(parsedOutput.data);
    }
  }
  state.finishReason = result.finishReason;
  state.providerFinishReason = result.providerFinishReason;
  state.usage = aggregateTokenUsage([state.usage, result.usage]);
  state.pendingApprovals = pendingApprovals;
  state.updatedAt = Date.now();

  return toOutput(state);
};

const emitTelemetryEvent = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  event: AgentTelemetryEvent
) => {
  await invokeOperationalHook(
    agent,
    "telemetry",
    event.type,
    event.runId,
    agent.onTelemetryEvent ? () => agent.onTelemetryEvent!(event) : undefined,
    undefined
  );
};

const emitInvocationStartTelemetry = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  runId: string,
  startedAt: number,
  maxSteps: number
) => {
  try {
    await agent.onTelemetryEvent?.startInvocation?.({
      runId,
      agentId: agent.id,
      agentName: agent.name,
      provider: agent.model.provider,
      modelId: agent.model.modelId,
      maxSteps,
      startedAt
    });
  } catch {
    // Invocation telemetry is best-effort and cannot replace setup/business errors.
  }
};

const emitInvocationFinishTelemetry = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  runId: string,
  status: AgentStatus,
  error: Error | undefined
) => {
  try {
    await agent.onTelemetryEvent?.finishInvocation?.({
      runId,
      agentId: agent.id,
      agentName: agent.name,
      status,
      error,
      finishedAt: Date.now()
    });
  } catch {
    // Invocation telemetry is best-effort and cannot replace setup/business errors.
  }
};

const withAgentTelemetryRunContext = <TModel extends LanguageModel, TResult>(
  agent: AgentDefinition<TModel>,
  runId: string,
  callback: () => TResult | Promise<TResult>
): Promise<TResult> => {
  const telemetryObserver = agent.onTelemetryEvent;
  const wrapper = telemetryObserver?.withRunContext;
  if (!wrapper) return Promise.resolve().then(callback);

  let execution: Promise<TResult> | undefined;
  let callbackError: unknown;
  let callbackFailed = false;
  const executeOnce = () => {
    execution ??= Promise.resolve()
      .then(callback)
      .catch((error) => {
        callbackFailed = true;
        callbackError = error;
        throw error;
      });
    return execution;
  };

  return Promise.resolve()
    .then(async () => {
      await wrapper.call(telemetryObserver, runId, executeOnce);
      return executeOnce();
    })
    .catch(async (wrapperError) => {
      if (callbackFailed) throw callbackError;
      try {
        return await executeOnce();
      } catch (executionError) {
        throw callbackFailed ? callbackError : executionError ?? wrapperError;
      }
    });
};

const subAgentToolInputSchema = z.object({
  prompt: z.string().min(1),
  system: z.string().optional()
});

const defaultSubAgentToolName = (agent: AgentDefinition): string => {
  const id = agent.id ?? `${agent.model.provider}_${agent.model.modelId}`;
  return `subagent_${id.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "agent"}`;
};

const countToolCallsInSteps = (steps: AgentStep[]): number =>
  steps.reduce((total, step) => total + countToolCalls(step.response?.messages ?? []), 0);

const countToolErrors = (toolResults: ToolExecutionResult[]): number =>
  toolResults.filter((result) => result.isError).length;

export const createSubAgentTool = <TModel extends LanguageModel>(
  options: CreateSubAgentToolOptions<TModel>
): ToolDefinition<typeof subAgentToolInputSchema, SubAgentToolOutput> => {
  const runtimeState = (
    options as CreateSubAgentToolOptions<TModel> & { runtimeState?: AgentRunState }
  ).runtimeState;
  const toolName = options.toolName ?? options.name ?? defaultSubAgentToolName(options.agent);
  const metadata: Record<string, JsonValue> = {
    type: "subagent"
  };
  if (options.agent.id) {
    metadata.childAgentId = options.agent.id;
  }
  if (options.parentRunId) {
    metadata.parentRunId = options.parentRunId;
  }
  if (options.parentAgentId) {
    metadata.parentAgentId = options.parentAgentId;
  }

  return {
    name: toolName,
    description:
      options.description ??
      `Delegate the task to ${options.agent.id ? `subagent "${options.agent.id}"` : "a subagent"} and return its result.`,
    schema: subAgentToolInputSchema,
    requiresApproval: options.requiresApproval,
    metadata: cloneMetadata(metadata, options.metadata),
    execute: async (input: SubAgentToolInput, executionContext) => {
      await options.onStart?.({
        toolName,
        childAgentId: options.agent.id,
        parentRunId: options.parentRunId
      });
      const childMetadata: Record<string, JsonValue> = {
        subagentToolName: toolName
      };
      if (options.parentRunId) {
        childMetadata.parentRunId = options.parentRunId;
      }
      if (options.parentAgentId) {
        childMetadata.parentAgentId = options.parentAgentId;
      }
      const toolCallId = executionContext?.toolCall.id;
      const childIdempotencyKey =
        options.parentRunId &&
        toolCallId &&
        executionContext &&
        options.agent.store?.claimIdempotencyKey
          ? `subagent:${durableToolCallId(
              options.parentRunId,
              executionContext.step,
              toolCallId,
              toolName,
              serializeJsonValue(input)
            )}`
          : undefined;
      const checkpoint = runtimeState?.childRuns?.find(
        (childRun) => childRun.toolCallId === toolCallId && childRun.resumeState
      );
      const childApprovalResponses = checkpoint
        ? (runtimeState?.approvalHistory ?? [])
            .filter(
              (resolution) =>
                resolution.kind === "subagent" &&
                resolution.toolCallId === toolCallId &&
                resolution.childRunId === checkpoint.runId &&
                resolution.childApprovalRequestId
            )
            .map((resolution) => ({
              provider: resolution.provider,
              approvalRequestId: resolution.childApprovalRequestId!,
              approve: resolution.approve,
              reason: resolution.reason
            }))
        : [];
      const output = checkpoint?.resumeState
        ? await resumeAgent(options.agent, {
            state: checkpoint.resumeState,
            approvals: childApprovalResponses,
            scope: options.scope,
            context: executionContext?.context,
            maxSteps: options.maxSteps
          })
        : await runAgent(options.agent, {
            prompt: input.prompt,
            system: joinInstructions(options.system, input.system),
            parentRunId: options.parentRunId,
            idempotencyKey: childIdempotencyKey,
            scope: options.scope,
            context: executionContext?.context,
            maxSteps: options.maxSteps,
            metadata: cloneMetadata(options.metadata, childMetadata)
          });
      const childRun: AgentChildRun = {
        runId: output.state.runId,
        status: output.status,
        outputText: output.outputText,
        steps: output.state.currentStep,
        toolCalls: countToolCallsInSteps(output.steps),
        toolErrors: countToolErrors(output.toolResults)
      };
      if (toolCallId) {
        childRun.toolCallId = toolCallId;
      }
      if (output.state.agentId) {
        childRun.agentId = output.state.agentId;
      }
      if (options.parentRunId) {
        childRun.parentRunId = options.parentRunId;
      }
      childRun.toolName = toolName;
      if (output.usage) {
        childRun.usage = output.usage;
      }
      if (output.state.startedAt !== undefined) {
        childRun.startedAt = output.state.startedAt;
      }
      if (output.state.updatedAt !== undefined) {
        childRun.updatedAt = output.state.updatedAt;
      }
      if (output.error) {
        childRun.error = output.error;
      }
      if (output.state.metadata) {
        childRun.metadata = output.state.metadata;
      }
      if (output.status === "waiting_approval" && output.state.pendingApprovals.length) {
        childRun.resumeState = output.state;
      }
      await options.onFinish?.(childRun);
      if (childRun.resumeState) {
        const approvals = childRun.resumeState.pendingApprovals.map((approval) => {
          const id = `subapproval_${createHash("sha256")
            .update(
              `${options.parentRunId ?? ""}\0${toolCallId ?? ""}\0${childRun.runId}\0${approval.id}`
            )
            .digest("hex")}`;
          return {
            kind: "subagent",
            provider: approval.provider,
            id,
            name: approval.name,
            arguments: approval.arguments,
            serverLabel: approval.serverLabel,
            toolCallId,
            step: executionContext?.step,
            childRunId: childRun.runId,
            childAgentId: childRun.agentId,
            childApprovalRequestId: approval.id,
            rawData: {
              type: "subagent_approval_request",
              childRunId: childRun.runId,
              childAgentId: childRun.agentId ?? null,
              childApprovalRequestId: approval.id,
              approval: approval.rawData
            }
          } satisfies AgentApprovalRequest;
        });
        throw new ToolExecutionSuspendedError(approvals);
      }
      return serializeJsonValue(childRun) as SubAgentToolOutput;
    }
  };
};

const saveStateWithRevision = async (store: AgentRunStore, state: AgentRunState) => {
  const expectedRevision = state.revision ?? 0;
  const nextRevision = expectedRevision + 1;
  const nextState = { ...state, revision: nextRevision } satisfies AgentRunState;
  await store.save(cloneState(nextState), { expectedRevision });
  state.revision = nextRevision;
};

const claimAgentExecution = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState
) => {
  state.status = "running";
  state.updatedAt = Date.now();
  assertStateSize(agent, state);
  if (agent.store) {
    await saveStateWithRevision(agent.store, state);
  }
};

const assertStateSize = <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState,
  policy?: AgentRunPolicy
) => {
  const limit = policy?.maxStateBytes ?? agent.policy?.maxStateBytes ?? DEFAULT_AGENT_MAX_STATE_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new ValidationError('Agent policy "maxStateBytes" must be a positive integer.');
  }
  const bytes = new TextEncoder().encode(JSON.stringify(state)).byteLength;
  if (bytes > limit) {
    throw new ValidationError(
      `Agent run state is ${bytes} bytes and exceeds maxStateBytes=${limit}. Offload large tool outputs to artifacts or raise the explicit limit.`
    );
  }
};

const persistState = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState,
  policy?: AgentRunPolicy
) => {
  state.updatedAt = Date.now();
  assertStateSize(agent, state, policy);
  if (agent.store) {
    await saveStateWithRevision(agent.store, state);
  }
  await emitTelemetryEvent(agent, {
    type: "state-saved",
    runId: state.runId,
    agentId: state.agentId,
    status: state.status
  });
  await invokeOperationalHook(
    agent,
    "memory",
    "save",
    state.runId,
    agent.memory?.save
      ? () => agent.memory!.save!({
          runId: state.runId,
          agentId: state.agentId,
          scope: state.scope,
          state: cloneState(state),
          metadata: state.metadata
        })
      : undefined,
    undefined
  );
};

const approvalsFromEvents = (messages: ModelMessage[]): AgentApprovalRequest[] => getAgentApprovalRequests(messages);

const emitFinalizedStepTelemetry = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState,
  steps: AgentStep[]
) => {
  for (const step of steps) {
    await emitTelemetryEvent(agent, {
      type: "step-finish",
      runId: state.runId,
      agentId: state.agentId,
      step
    });
  }
};

const emitApprovalTelemetry = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState,
  approvals: AgentApprovalRequest[]
) => {
  for (const approval of approvals) {
    await emitTelemetryEvent(agent, {
      type: "approval-request",
      runId: state.runId,
      agentId: state.agentId,
      approval
    });
  }
};

const emitToolApprovalTelemetry = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState,
  event: ToolApprovalEvent
) => {
  await emitTelemetryEvent(agent, {
    type: "tool-approval",
    runId: state.runId,
    agentId: state.agentId,
    toolCall: event.request.toolCall,
    approved: event.decision.approved,
    reason: event.decision.reason,
    metadata: event.decision.metadata
  });
};

const normalizeGuardrailTrigger = (value: AgentGuardrailTrigger | void): AgentGuardrailTrigger | undefined =>
  value?.triggered ? value : undefined;

const applyGuardrailFailure = (
  state: AgentRunState,
  stage: "input" | "output",
  trigger: AgentGuardrailTrigger
): AgentRunState => ({
  ...state,
  status: "failed",
  error: {
    message: trigger.reason ?? `Agent ${stage} guardrail triggered.`
  },
  updatedAt: Date.now()
});

const runGuardrails = async <TModel extends LanguageModel, TRequest>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState,
  stage: "input" | "output",
  guardrails: ReadonlyArray<((request: TRequest) => AgentGuardrailTrigger | void | Promise<AgentGuardrailTrigger | void>)> | undefined,
  requestFactory: (index: number) => TRequest
): Promise<AgentGuardrailTrigger | undefined> => {
  for (const [index, guardrail] of (guardrails ?? []).entries()) {
    const trigger = normalizeGuardrailTrigger(await guardrail(requestFactory(index)));
    if (!trigger) {
      continue;
    }

    await emitTelemetryEvent(agent, {
      type: "guardrail-triggered",
      runId: state.runId,
      agentId: state.agentId,
      stage,
      reason: trigger.reason ?? `Agent ${stage} guardrail #${index + 1} triggered.`,
      metadata: trigger.metadata
    });
    return trigger;
  }

  return undefined;
};

const bindDurableRuntime = (
  agent: AgentDefinition,
  input: AgentRunInput,
  state: AgentRunState,
  executionEnvironment: AgentExecutionEnvironmentBinding | undefined
) => {
  const policy = {
    ...(agent.policy ?? {}),
    ...(input.policy ?? {})
  };
  if (state.harness && !agent.harness) {
    throw new ConflictError(
      `Agent run "${state.runId}" is bound to harness "${state.harness.id}", but the current agent has no harness binding.`
    );
  }
  if (state.harness && agent.harness) {
    if (
      state.harness.id !== agent.harness.id ||
      state.harness.version !== agent.harness.version ||
      state.harness.fingerprint !== agent.harness.fingerprint
    ) {
      throw new ConflictError(`Agent run "${state.runId}" was created by a different harness fingerprint.`);
    }
  } else if (!state.harness && agent.harness) {
    if (!policy?.allowLegacyHarnessResume) {
      throw new ConflictError(
        `Agent run "${state.runId}" predates harness binding; set allowLegacyHarnessResume only for an explicit migration.`
      );
    }
    state.harness = agent.harness;
  }

  if (state.executionEnvironment && !executionEnvironment) {
    throw new ConflictError(
      `Agent run "${state.runId}" is bound to execution environment "${state.executionEnvironment.environmentId}".`
    );
  }
  if (state.executionEnvironment && executionEnvironment) {
    if (
      state.executionEnvironment.environmentId !== executionEnvironment.environmentId ||
      state.executionEnvironment.environmentVersion !== executionEnvironment.environmentVersion ||
      state.executionEnvironment.fingerprint !== executionEnvironment.fingerprint ||
      state.executionEnvironment.workspaceId !== executionEnvironment.workspaceId
    ) {
      throw new ConflictError(`Agent run "${state.runId}" was created in a different execution environment.`);
    }
  } else if (!state.executionEnvironment && executionEnvironment) {
    if (!policy?.allowLegacyExecutionEnvironmentResume) {
      throw new ConflictError(
        `Agent run "${state.runId}" predates execution-environment binding; enable the explicit migration policy to resume it.`
      );
    }
    state.executionEnvironment = executionEnvironment;
  }
};

const validateHarnessBinding = (binding: AgentDefinition["harness"]) => {
  if (!binding) {
    return;
  }
  if (
    binding.schemaVersion !== 1 ||
    binding.algorithm !== "sha256" ||
    !binding.id ||
    !binding.version ||
    !/^sha256:[0-9a-f]{64}$/.test(binding.fingerprint)
  ) {
    throw new ValidationError("Agent harness binding is invalid.");
  }
};

const resolveContext = async <
  TModel extends LanguageModel,
  TContext,
  TOutput
>(
  agent: AgentDefinition<TModel, TContext, TOutput>,
  input: AgentRunInput<TModel, TContext>
) => {
  validateHarnessBinding(agent.harness);
  const executionEnvironment = input.executionEnvironment ?? agent.executionEnvironment;
  const executionEnvironmentBinding = executionEnvironment
    ? createAgentExecutionEnvironmentBinding(executionEnvironment.manifest)
    : undefined;
  let parsedContext = input.context;
  if (agent.contextSchema) {
    const result = await agent.contextSchema.safeParseAsync(input.context);
    if (!result.success) {
      throw new ValidationError(`Invalid agent context: ${result.error.message}`);
    }
    parsedContext = result.data;
  }
  ensureValidIdempotencyInput(input, agent.store);
  const inputScope = input.scope ?? input.handoff?.scope;
  ensureValidScope(inputScope);

  let loadedState = input.state ? normalizeAgentRunState(input.state) : undefined;
  let loadedByIdempotencyKey = false;
  if (!loadedState && input.runId && agent.store) {
    loadedState = await agent.store.load(input.runId, inputScope);
    if (loadedState) {
      loadedState = normalizeAgentRunState(loadedState);
    }
  }

  if (!loadedState && input.idempotencyKey) {
    const runId = input.runId ?? randomId("run");
    const maxSteps = Math.max(1, input.maxSteps ?? agent.maxSteps ?? 1);
    const metadata = cloneMetadata(agent.metadata, input.metadata, input.handoff?.metadata);
    const prepared = await prepareFreshMessages(agent, input, runId);
    const candidate = createBaseState(
      agent.model.provider,
      agent.model.modelId,
      prepared.messages,
      maxSteps,
      metadata,
      agent.id,
      runId,
      input.handoff,
      input.parentRunId,
      input.idempotencyKey,
      inputScope,
      resolveAgentOutputMode(agent),
      agent.harness,
      executionEnvironmentBinding
    ) as AgentRunState & { idempotencyKey: string };
    const claim = await agent.store!.claimIdempotencyKey!(candidate);
    if (claim.claimed) {
      return {
        state: normalizeAgentRunState(claim.state),
        messages: prepared.messages,
        remainingSteps: maxSteps,
        memoryMessages: prepared.memoryMessages,
        context: parsedContext,
        executionEnvironment,
        fresh: true
      };
    }
    loadedState = normalizeAgentRunState(claim.state);
    loadedByIdempotencyKey = true;
  }

  const normalizedInput =
    loadedState && loadedByIdempotencyKey
      ? { ...input, prompt: undefined, messages: undefined, system: undefined, handoff: undefined, state: loadedState }
      : loadedState
        ? { ...input, state: loadedState }
        : input;
  ensureValidStateInput(normalizedInput);

  const metadata = cloneMetadata(agent.metadata, loadedState?.metadata, input.metadata, input.handoff?.metadata);
  if (loadedState) {
    bindDurableRuntime(agent, input, loadedState, executionEnvironmentBinding);
    const maxSteps = input.maxSteps ?? loadedState.maxSteps;
    const resumed = await applyApprovalResponses(
      loadedState.messages,
      input.approvals,
      loadedState.pendingApprovals,
      loadedState.approvalHistory,
      agent.toolApprovalSigner
    );

    return {
      state: {
        ...loadedState,
        schemaVersion: AGENT_RUN_STATE_SCHEMA_VERSION,
        idempotencyKey: loadedState.idempotencyKey ?? input.idempotencyKey,
        scope: loadedState.scope ?? inputScope,
        agentId: loadedState.agentId ?? agent.id,
        parentRunId: loadedState.parentRunId ?? input.parentRunId,
        provider: agent.model.provider,
        modelId: agent.model.modelId,
        maxSteps,
        messages: resumed.messages,
        pendingApprovals: resumed.pendingApprovals,
        approvalHistory: resumed.approvalHistory,
        metadata,
        updatedAt: Date.now()
      } satisfies AgentRunState,
      messages: resumed.messages,
      remainingSteps: Math.max(0, maxSteps - loadedState.currentStep),
      memoryMessages: [] as ModelMessage[],
      context: parsedContext,
      executionEnvironment,
      fresh: false
    };
  }

  const runId = input.runId ?? randomId("run");
  const maxSteps = Math.max(1, input.maxSteps ?? agent.maxSteps ?? 1);
  const prepared = await prepareFreshMessages(agent, input, runId);

  return {
    state: createBaseState(
      agent.model.provider,
      agent.model.modelId,
      prepared.messages,
      maxSteps,
      metadata,
      agent.id,
      runId,
      input.handoff,
      input.parentRunId,
      input.idempotencyKey,
      inputScope,
      resolveAgentOutputMode(agent),
      agent.harness,
      executionEnvironmentBinding
    ),
    messages: prepared.messages,
    remainingSteps: maxSteps,
    memoryMessages: prepared.memoryMessages,
    context: parsedContext,
    executionEnvironment,
    fresh: true
  };
};

const canonicalJson = (value: JsonValue): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
};

const durableToolCallId = (
  runId: string,
  step: number,
  providerToolCallId: string,
  toolName: string,
  input: JsonValue
): string =>
  `tool_${createHash("sha256")
    .update(`${runId}\0${step}\0${providerToolCallId}\0${toolName}\0${canonicalJson(input)}`)
    .digest("hex")}`;

const wrapToolWithExecutionEnvironment = (
  tool: ToolDefinition,
  session: AgentExecutionEnvironmentSession
): ToolDefinition => {
  const authorize = async (
    input: unknown,
    context: ToolExecutionContext,
    phase: "preflight" | "execute"
  ) => session.authorize({
    manifest: session.manifest,
    binding: session.binding,
    tool,
    toolCall: context.toolCall,
    input,
    context,
    phase
  });
  const environmentGuardrail: ToolInputGuardrail = async ({ input, context }) => {
    const decision = await authorize(input, context, "preflight");
    return decision.decision === "deny"
      ? {
          triggered: true,
          reason: decision.reason,
          metadata: decision.metadata
        }
      : undefined;
  };

  return {
    ...tool,
    approvalVersion: [
      tool.approvalVersion,
      `environment:${session.binding.fingerprint}`
    ].filter(Boolean).join("|"),
    inputGuardrails: [
      environmentGuardrail,
      ...(tool.inputGuardrails ?? [])
    ],
    execute: async (input, context) => {
      if (!context) {
        throw new ValidationError(`Tool "${tool.name}" requires an execution environment context.`);
      }
      const decision = await authorize(input, context, "execute");
      if (decision.decision === "deny") {
        throw new GuardrailTriggeredError(
          "tool-input",
          decision.reason,
          { metadata: decision.metadata }
        );
      }
      const request = {
        manifest: session.manifest,
        binding: session.binding,
        tool,
        toolCall: context.toolCall,
        input,
        context,
        phase: "execute" as const
      };
      return session.execute(request, () => tool.execute(input, context));
    }
  } as ToolDefinition;
};

const wrapToolWithJournal = <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState,
  tool: ToolDefinition
): ToolDefinition => {
  const store = agent.store;
  if (!store?.claimToolExecution || !store.loadToolExecution || !store.completeToolExecution) {
    return tool;
  }

  return {
    ...tool,
    execute: async (input, context) => {
      if (!context) {
        throw new ValidationError(`Durable tool "${tool.name}" requires an execution context.`);
      }
      const serializedInput = serializeJsonValue(input);
      const step = context.step;
      const toolCallId = durableToolCallId(state.runId, step, context.toolCall.id, tool.name, serializedInput);
      const idempotencyKey = `${state.runId}:${toolCallId}`;
      const now = Date.now();
      const candidate = {
        runId: state.runId,
        scope: state.scope,
        toolCallId,
        toolName: tool.name,
        status: "pending",
        idempotencyKey,
        revision: 0,
        input: serializedInput,
        updatedAt: now
      } satisfies AgentToolCallJournalEntry;
      const claim = await store.claimToolExecution!(candidate);

      if (!claim.claimed) {
        if (claim.entry.status === "completed") {
          return claim.entry.output ?? null;
        }
        if (claim.entry.status === "failed") {
          throw new Error(claim.entry.error?.message ?? `Tool "${tool.name}" previously failed.`);
        }
        throw new ConflictError(
          `Tool "${tool.name}" has an indeterminate durable execution. Reconcile idempotency key "${claim.entry.idempotencyKey}" before retrying.`
        );
      }

      try {
        const output = serializeJsonValue(
          await tool.execute(input, {
            ...context,
            runId: state.runId,
            idempotencyKey
          })
        );
        await store.completeToolExecution!(
          {
            ...claim.entry,
            status: "completed",
            output,
            completedAt: Date.now(),
            updatedAt: Date.now()
          },
          { expectedRevision: claim.entry.revision }
        );
        return output;
      } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        try {
          await store.completeToolExecution!(
            {
              ...claim.entry,
              status: "failed",
              error: { message: normalizedError.message },
              completedAt: Date.now(),
              updatedAt: Date.now()
            },
            { expectedRevision: claim.entry.revision }
          );
        } catch {
          // The original error is more useful; a running journal row blocks unsafe replay.
        }
        throw normalizedError;
      }
    }
  };
};

const defaultEstimateInputTokens = (messages: readonly ModelMessage[]): number =>
  Math.ceil(new TextEncoder().encode(JSON.stringify(messages)).byteLength / 4);

const validateCompactionOptions = (options: AgentCompactionOptions) => {
  if (
    options.maxMessages !== undefined &&
    (!Number.isSafeInteger(options.maxMessages) || options.maxMessages < 2)
  ) {
    throw new ValidationError("Agent compaction maxMessages must be an integer greater than or equal to 2.");
  }
  if (
    options.maxEstimatedInputTokens !== undefined &&
    (!Number.isSafeInteger(options.maxEstimatedInputTokens) || options.maxEstimatedInputTokens < 1)
  ) {
    throw new ValidationError("Agent compaction maxEstimatedInputTokens must be a positive integer.");
  }
  if (
    options.keepRecentMessages !== undefined &&
    (!Number.isSafeInteger(options.keepRecentMessages) || options.keepRecentMessages < 1)
  ) {
    throw new ValidationError("Agent compaction keepRecentMessages must be a positive integer.");
  }
  if (options.maxMessages === undefined && options.maxEstimatedInputTokens === undefined) {
    throw new ValidationError("Agent compaction requires maxMessages or maxEstimatedInputTokens.");
  }
};

const compactAgentMessages = async <TContext>(
  options: AgentCompactionOptions<TContext>,
  state: AgentRunState,
  messages: readonly ModelMessage[],
  beforeStep: number,
  context: TContext | undefined,
  abortSignal: AbortSignal | undefined
): Promise<{ messages: ModelMessage[]; record: AgentCompactionRecord } | undefined> => {
  validateCompactionOptions(options);
  if (state.pendingApprovals.length) {
    return undefined;
  }

  const estimateTokens = options.estimateTokens ?? defaultEstimateInputTokens;
  const estimatedTokensBefore = estimateTokens(messages);
  const reasons: AgentCompactionReason[] = [];
  if (options.maxMessages !== undefined && messages.length > options.maxMessages) {
    reasons.push("message-count");
  }
  if (
    options.maxEstimatedInputTokens !== undefined &&
    estimatedTokensBefore > options.maxEstimatedInputTokens
  ) {
    reasons.push("estimated-input-tokens");
  }
  if (!reasons.length) {
    return undefined;
  }

  let systemCount = 0;
  while (messages[systemCount]?.role === "system") {
    systemCount += 1;
  }
  const maxTailForMessageLimit = options.maxMessages === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(1, options.maxMessages - systemCount - 1);
  const keepRecentMessages = Math.min(
    options.keepRecentMessages ?? 8,
    maxTailForMessageLimit
  );
  let cut = Math.max(systemCount, messages.length - keepRecentMessages);
  while (cut > systemCount && messages[cut]?.role === "tool") {
    cut -= 1;
  }
  if (cut <= systemCount) {
    throw new ValidationError("Agent compaction cannot satisfy its limits without removing protected messages.");
  }

  const compactedMessages = structuredClone(messages.slice(systemCount, cut));
  const retainedMessages = structuredClone(messages.slice(cut));
  const sourceDigest = fingerprintAgentHarness(messages);
  const id = `cmp_${createHash("sha256")
    .update(`${state.runId}\0${beforeStep}\0${sourceDigest}`)
    .digest("hex")}`;
  const result = await options.compactor({
    runId: state.runId,
    agentId: state.agentId,
    scope: state.scope,
    beforeStep,
    context,
    messages: compactedMessages,
    retainedMessages,
    reasons,
    estimatedTokensBefore,
    sourceDigest,
    idempotencyKey: id,
    metadata: state.metadata,
    abortSignal
  });
  const summary = result.summary.trim();
  if (!summary) {
    throw new ValidationError("Agent compactor returned an empty summary.");
  }

  const compacted = [
    ...structuredClone(messages.slice(0, systemCount)),
    createTextMessage("assistant", `[Compacted prior conversation]\n${summary}`),
    ...retainedMessages
  ];
  const estimatedTokensAfter = estimateTokens(compacted);
  if (compacted.length >= messages.length || estimatedTokensAfter >= estimatedTokensBefore) {
    throw new ValidationError("Agent compaction must reduce both message count and estimated input tokens.");
  }
  if (options.maxMessages !== undefined && compacted.length > options.maxMessages) {
    throw new ValidationError("Agent compaction result still exceeds maxMessages.");
  }
  if (
    options.maxEstimatedInputTokens !== undefined &&
    estimatedTokensAfter > options.maxEstimatedInputTokens
  ) {
    throw new ValidationError("Agent compaction result still exceeds maxEstimatedInputTokens.");
  }

  const resultDigest = fingerprintAgentHarness(compacted);
  return {
    messages: compacted,
    record: {
      id,
      beforeStep,
      createdAt: Date.now(),
      reasons,
      sourceDigest,
      resultDigest,
      summaryDigest: fingerprintAgentHarness(summary),
      summary,
      messageCountBefore: messages.length,
      messageCountAfter: compacted.length,
      compactedMessageCount: compactedMessages.length,
      retainedMessageCount: retainedMessages.length,
      estimatedTokensBefore,
      estimatedTokensAfter,
      usage: result.usage,
      metadata: result.metadata
    }
  };
};

const createGenerateOptions = <
  TModel extends LanguageModel,
  TContext,
  TOutput
>(
  agent: AgentDefinition<TModel, TContext, TOutput>,
  state: AgentRunState,
  input: AgentRunInput<TModel, TContext>,
  messages: ModelMessage[],
  maxSteps: number,
  context: TContext | undefined,
  executionEnvironmentSession: AgentExecutionEnvironmentSession<TContext> | undefined,
  abortSignal: AbortSignal | undefined = input.abortSignal,
  onCompaction?: (record: AgentCompactionRecord) => void | Promise<void>
): GenerateTextOptions<TModel, TContext> => {
  const tools = { ...(toToolSet(input.tools ?? agent.tools) ?? {}) };
  for (const subagent of agent.subagents ?? []) {
    const subagentTool = createSubAgentTool({
      ...subagent,
      agent: {
        ...subagent.agent,
        store: subagent.agent.store ?? agent.store,
        memory: subagent.agent.memory ?? agent.memory,
        executionEnvironment:
          subagent.agent.executionEnvironment ??
          input.executionEnvironment ??
          agent.executionEnvironment,
        compaction: subagent.agent.compaction ?? (
          input.compaction === false
            ? undefined
            : input.compaction ?? agent.compaction
        )
      },
      parentRunId: state.runId,
      parentAgentId: state.agentId,
      scope: state.scope,
      runtimeState: state,
      onStart: async ({ toolName, childAgentId }) => {
        await emitTelemetryEvent(agent, {
          type: "subagent-start",
          runId: state.runId,
          agentId: state.agentId,
          childAgentId,
          toolName
        });
      },
      onFinish: async (childRun) => {
        state.childRuns = [
          ...(state.childRuns ?? []).filter(
            (existing) => childRun.toolCallId
              ? existing.toolCallId !== childRun.toolCallId
              : existing.runId !== childRun.runId
          ),
          childRun
        ];
        await emitTelemetryEvent(agent, {
          type: "subagent-finish",
          runId: state.runId,
          agentId: state.agentId,
          childRun
        });
      }
    } as CreateSubAgentToolOptions & { runtimeState: AgentRunState });
    if (tools[subagentTool.name]) {
      throw new ValidationError(`Subagent tool "${subagentTool.name}" conflicts with an existing tool.`);
    }
    tools[subagentTool.name] = subagentTool;
  }
  for (const [name, tool] of Object.entries(tools)) {
    if (isCallableToolDefinition(tool)) {
      const environmentTool = executionEnvironmentSession
        ? wrapToolWithExecutionEnvironment(tool, executionEnvironmentSession)
        : tool;
      tools[name] = tool.metadata?.type === "subagent"
        ? environmentTool
        : wrapToolWithJournal(agent, state, environmentTool);
    }
  }
  const finalTools = Object.keys(tools).length ? tools : undefined;
  const budget = input.policy?.budget ?? agent.policy?.budget;
  const runPolicy = resolveRunPolicy(agent, input);
  const compaction = input.compaction === false
    ? undefined
    : input.compaction ?? agent.compaction;
  let checkpointState = cloneState(state);
  let reservedToolCalls = 0;
  const requestedMaxTokens = input.maxTokens ?? agent.maxTokens;
  const budgetStatus = budget ? getAgentBudgetStatus(state, budget) : undefined;
  const tokenCeilings = [
    requestedMaxTokens,
    budgetStatus?.remaining.outputTokens,
    budgetStatus?.remaining.totalTokens
  ].filter((value): value is number => value !== undefined);
  const maxTokens = tokenCeilings.length ? Math.min(...tokenCeilings) : undefined;
  const requestedToolExecution = input.toolExecution ?? agent.toolExecution;
  const toolExecution = agent.subagents?.length
    ? {
        ...requestedToolExecution,
        parallel: false,
        maxConcurrency: 1
      }
    : requestedToolExecution;

  return {
    model: agent.model,
    messages,
    tools: finalTools,
    toolChoice: input.toolChoice,
    toolExecution,
    toolApprovalPolicy: input.toolApprovalPolicy ?? agent.toolApprovalPolicy,
    toolApprovalSigner: agent.toolApprovalSigner,
    toolApprovalResolutions: state.approvalHistory,
    toolContext: {
      context,
      runId: state.runId,
      agentId: state.agentId,
      agentName: agent.name,
      scope: state.scope,
      metadata: state.metadata,
      executionEnvironment: executionEnvironmentSession
    },
    onToolApprovalDecision: async (event) => {
      await emitToolApprovalTelemetry(agent, state, event);
    },
    prepareModelMessages: compaction
      ? async ({ messages: activeMessages, step }) => {
          const compacted = await compactAgentMessages(
            compaction,
            checkpointState,
            activeMessages,
            step,
            context,
            abortSignal
          );
          if (!compacted) {
            return undefined;
          }
          checkpointState = {
            ...checkpointState,
            messages: compacted.messages,
            usage: aggregateTokenUsage([
              checkpointState.usage,
              compacted.record.usage
            ]),
            compactions: [
              ...(checkpointState.compactions ?? []).filter(
                (existing) => existing.id !== compacted.record.id
              ),
              compacted.record
            ],
            updatedAt: Date.now()
          };
          state.messages = compacted.messages;
          state.usage = checkpointState.usage;
          state.compactions = checkpointState.compactions;
          await persistState(agent, checkpointState, runPolicy);
          state.revision = checkpointState.revision;
          await onCompaction?.(compacted.record);
          return compacted.messages;
        }
      : undefined,
    onBeforeModelStep: async ({ step }) => {
      if (budget) {
        const trigger = evaluateAgentBudgetPreflight(state, budget, {
          operation: "model",
          requiredSteps: Math.max(1, step - state.currentStep),
          requestedOutputTokens: maxTokens
        });
        if (trigger) {
          throw new GuardrailTriggeredError("input", trigger.reason ?? "Agent model budget preflight failed.", {
            metadata: trigger.metadata
          });
        }
      }

      await emitTelemetryEvent(agent, {
        type: "step-start",
        runId: state.runId,
        agentId: state.agentId,
        agentName: agent.name,
        stepIndex: step,
        startedAt: Date.now()
      });
    },
    onModelStep: async ({ request, response, step, toolCalls, approvalRequests }) => {
      if (!agent.store) return;
      const responseSnapshot = snapshotResponse(response);
      const approvals = [
        ...approvalRequests,
        ...getAgentApprovalRequests(responseSnapshot.messages)
      ];
      const crossedCompactionBoundary = checkpointState.compactions?.some(
        (record) =>
          record.beforeStep === step &&
          record.resultDigest === fingerprintAgentHarness(request.messages)
      );
      const requestOffset = crossedCompactionBoundary
        ? 0
        : messagePrefixLength(checkpointState.messages, request.messages);
      const timing = getGenerateTextStepTiming(request);
      const finishedAt = timing?.finishedAt ?? Date.now();
      const checkpointStep = {
        index: step,
        status: approvals.length ? "waiting_approval" : "completed",
        startedAt: timing?.startedAt ?? finishedAt,
        finishedAt,
        request: snapshotRequest(request, requestOffset, request.messages.slice(requestOffset)),
        response: responseSnapshot,
        toolResults: []
      } satisfies AgentStep;
      checkpointState = {
        ...checkpointState,
        status: approvals.length ? "waiting_approval" : toolCalls.length ? "running" : "completed",
        messages: [...request.messages, ...responseSnapshot.messages],
        steps: [...checkpointState.steps.filter((existing) => existing.index !== step), checkpointStep],
        currentStep: step,
        outputText: response.text ?? checkpointState.outputText,
        finishReason: response.finishReason,
        providerFinishReason: response.providerFinishReason,
        usage: aggregateTokenUsage([checkpointState.usage, response.usage]),
        pendingApprovals: approvals,
        error: undefined,
        updatedAt: Date.now()
      };
      await persistState(agent, checkpointState, runPolicy);
      state.revision = checkpointState.revision;
    },
    onToolExecutionComplete: async ({ toolResults }) => {
      if (!agent.store) return;
      const lastStep = checkpointState.steps.at(-1);
      if (lastStep) {
        lastStep.toolResults = [...lastStep.toolResults, ...toolResults];
      }
      checkpointState = {
        ...checkpointState,
        status: "running",
        messages: [
          ...checkpointState.messages,
          ...toolResults.map((toolResult) => ({
            role: "tool" as const,
            parts: [{ type: "tool-result" as const, toolResult }]
          }))
        ],
        toolResults: [...checkpointState.toolResults, ...toolResults],
        updatedAt: Date.now()
      };
      await persistState(agent, checkpointState, runPolicy);
      state.revision = checkpointState.revision;
    },
    stepOffset: state.currentStep,
    onBeforeToolExecution: async ({ step, toolCalls }) => {
      if (budget) {
        reservedToolCalls += toolCalls.length;
        const trigger = evaluateAgentBudgetPreflight(state, budget, {
          operation: "tool",
          requiredToolCalls: reservedToolCalls
        });
        if (trigger) {
          throw new GuardrailTriggeredError("input", trigger.reason ?? "Agent tool budget preflight failed.", {
            metadata: trigger.metadata
          });
        }
      }

      for (const toolCall of toolCalls) {
        await emitTelemetryEvent(agent, {
          type: "tool-start",
          runId: state.runId,
          agentId: state.agentId,
          agentName: agent.name,
          stepIndex: step,
          toolCall,
          startedAt: Date.now()
        });
      }
    },
    maxSteps,
    temperature: input.temperature ?? agent.temperature,
    maxTokens,
    reasoning: input.reasoning ?? agent.reasoning,
    structuredOutput:
      agent.outputSchema && resolveAgentOutputMode(agent) === "native"
        ? {
            schema: agent.outputSchema,
            mode: "native",
            name: agent.outputName,
            description: agent.outputDescription
          }
        : undefined,
    providerOptions: input.providerOptions ?? agent.providerOptions,
    abortSignal,
    timeoutMs: input.timeoutMs,
    maxRetries: input.maxRetries,
    retryBackoffMs: input.retryBackoffMs
  };
};

const emptyAsyncIterable = async function* () {
  return;
};

const createFailedState = (state: AgentRunState, message: string): AgentRunState => ({
  ...state,
  status: "failed",
  error: {
    message
  },
  updatedAt: Date.now()
});

const createTerminalState = (
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

const resolveRunPolicy = <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  input: AgentRunInput<TModel>
): AgentRunPolicy | undefined => {
  const policy = {
    ...(agent.policy ?? {}),
    ...(input.policy ?? {})
  };
  return Object.keys(policy).length ? policy : undefined;
};

const withAgentPolicyTimeout = async <T>(
  operation: Promise<T>,
  timeout: {
    signal?: AbortSignal;
    timeoutPromise?: Promise<never>;
    cleanup: () => void;
    isTimedOut: () => boolean;
  }
): Promise<T> => {
  try {
    return timeout.timeoutPromise
      ? await Promise.race([operation, timeout.timeoutPromise])
      : await operation;
  } finally {
    timeout.cleanup();
  }
};

const createAgentAbortContext = (
  inputAbortSignal: AbortSignal | undefined,
  policy: AgentRunPolicy | undefined,
  ...additionalSignals: Array<AbortSignal | undefined>
) => {
  if (!policy?.timeoutMs) {
    const merged = createMergedAbortSignal(inputAbortSignal, ...additionalSignals);
    return {
      signal: merged.signal,
      timeoutPromise: undefined,
      cleanup: merged.cleanup,
      isTimedOut: () => false
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new AgentPolicyTimeoutError(policy.timeoutMs!));
    }, policy.timeoutMs);
  });

  const merged = createMergedAbortSignal(inputAbortSignal, ...additionalSignals, controller.signal);
  return {
    signal: merged.signal,
    timeoutPromise,
    cleanup: () => {
      merged.cleanup();
      if (timeout) {
        clearTimeout(timeout);
      }
    },
    isTimedOut: () => timedOut
  };
};

const acquireExecutionEnvironment = async <TContext>(
  environment: AgentExecutionEnvironment<TContext> | undefined,
  state: AgentRunState,
  context: TContext | undefined,
  abortSignal: AbortSignal | undefined
): Promise<AgentExecutionEnvironmentSession<TContext> | undefined> => {
  if (!environment) {
    return undefined;
  }
  const expected = state.executionEnvironment;
  if (!expected) {
    throw new ConflictError(`Agent run "${state.runId}" has no durable execution-environment binding.`);
  }
  const session = await environment.acquire({
    runId: state.runId,
    agentId: state.agentId,
    scope: state.scope,
    context,
    metadata: state.metadata,
    abortSignal
  });
  const manifestBinding = createAgentExecutionEnvironmentBinding(session.manifest);
  if (
    session.binding.environmentId !== expected.environmentId ||
    session.binding.environmentVersion !== expected.environmentVersion ||
    session.binding.fingerprint !== expected.fingerprint ||
    session.binding.workspaceId !== expected.workspaceId ||
    manifestBinding.fingerprint !== expected.fingerprint
  ) {
    await session.release?.({
      status: "failed",
      error: { message: "Execution environment returned a binding that differs from the durable run." }
    });
    throw new ConflictError(`Execution environment binding changed for agent run "${state.runId}".`);
  }
  return session;
};

interface AgentExecutionLeaseContext {
  supported: boolean;
  signal?: AbortSignal;
  cancelledState: () => AgentRunState | undefined;
  leaseLost: () => boolean;
  release: () => Promise<void>;
}

const acquireAgentExecutionLease = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState,
  policy: AgentRunPolicy | undefined
): Promise<AgentExecutionLeaseContext | undefined> => {
  const store = agent.store;
  if (policy?.leaseMode === "disabled" || !store?.acquireLease || !store.renewLease || !store.releaseLease) {
    return {
      supported: false,
      cancelledState: () => undefined,
      leaseLost: () => false,
      release: async () => undefined
    };
  }

  const ttlMs = policy?.leaseTtlMs ?? DEFAULT_AGENT_LEASE_TTL_MS;
  const heartbeatMs = policy?.heartbeatMs ?? Math.max(250, Math.floor(ttlMs / 3));
  const cancellationPollMs = policy?.cancellationPollMs ?? DEFAULT_AGENT_CANCELLATION_POLL_MS;
  for (const [name, value] of [
    ["leaseTtlMs", ttlMs],
    ["heartbeatMs", heartbeatMs],
    ["cancellationPollMs", cancellationPollMs]
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ValidationError(`Agent policy "${name}" must be a positive integer.`);
    }
  }
  if (heartbeatMs >= ttlMs) {
    throw new ValidationError('Agent policy "heartbeatMs" must be less than "leaseTtlMs".');
  }

  const ownerId = randomId("worker");
  const lease = await store.acquireLease(state.runId, { ownerId, ttlMs }, state.scope);
  if (!lease) {
    return undefined;
  }

  const controller = new AbortController();
  let cancelled: AgentRunState | undefined;
  let lost = false;
  let stopped = false;
  let monitoring = false;
  let lastHeartbeat = Date.now();
  let lastCancellationPoll = 0;
  const intervalMs = Math.max(25, Math.min(heartbeatMs, cancellationPollMs));
  const timer = setInterval(async () => {
    if (stopped || monitoring) return;
    monitoring = true;
    const now = Date.now();
    try {
      if (now - lastHeartbeat >= heartbeatMs) {
        const renewed = await store.renewLease?.(state.runId, { ownerId, ttlMs }, state.scope);
        if (!renewed) {
          lost = true;
          controller.abort(new ConflictError(`Agent run "${state.runId}" lost its worker lease.`));
          return;
        }
        lastHeartbeat = now;
      }
      if (now - lastCancellationPoll >= cancellationPollMs) {
        const latest = await store.load(state.runId, state.scope);
        lastCancellationPoll = now;
        if (latest?.status === "cancel_requested" || latest?.status === "cancelled") {
          cancelled = normalizeAgentRunState(latest);
          controller.abort(new Error(latest.cancellationReason ?? "Agent run was cancelled."));
        }
      }
    } catch (error) {
      lost = true;
      controller.abort(error);
    } finally {
      monitoring = false;
    }
  }, intervalMs);
  timer.unref?.();

  return {
    supported: true,
    signal: controller.signal,
    cancelledState: () => cancelled,
    leaseLost: () => lost,
    release: async () => {
      stopped = true;
      clearInterval(timer);
      await store.releaseLease?.(state.runId, ownerId, state.scope);
    }
  };
};

const emitRunStartTelemetry = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState,
  memoryMessages: ModelMessage[],
  approvals: AgentApprovalResponse[] | undefined,
  invocationStartedAt: number
) => {
    await emitTelemetryEvent(agent, {
      type: "run-start",
      runId: state.runId,
      agentId: state.agentId,
      agentName: agent.name,
      provider: state.provider,
      modelId: state.modelId,
      maxSteps: state.maxSteps,
      startedAt: invocationStartedAt
  });

  if (state.handoff) {
    await emitTelemetryEvent(agent, {
      type: "handoff",
      runId: state.runId,
      agentId: state.agentId,
      handoff: state.handoff
    });
  }

  if (memoryMessages.length) {
    await emitTelemetryEvent(agent, {
      type: "memory-loaded",
      runId: state.runId,
      agentId: state.agentId,
      messageCount: memoryMessages.length
    });
  }

  for (const approval of approvals ?? []) {
    await emitTelemetryEvent(agent, {
      type: "approval-resolved",
      runId: state.runId,
      agentId: state.agentId,
      approval
    });
  }
};

const emitRunFinishTelemetry = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState
) => {
  await emitTelemetryEvent(agent, {
    type: "run-finish",
    runId: state.runId,
    agentId: state.agentId,
    agentName: agent.name,
    status: state.status,
    state: cloneState(state),
    finishedAt: Date.now()
  });
};

export const createAgent = <
  TModel extends AgentDefinition["model"],
  TContext = unknown,
  TOutput = unknown
>(
  definition: AgentDefinition<TModel, TContext, TOutput>
): AgentDefinition<TModel, TContext, TOutput> => ({
  ...definition,
  metadata: cloneMetadata(definition.metadata)
});

export class Agent<
  TModel extends LanguageModel = LanguageModel,
  TContext = unknown,
  TOutput = unknown
> implements AgentDefinition<TModel, TContext, TOutput> {
  id?: string;
  name?: string;
  model: TModel;
  instructions?: string;
  contextSchema?: z.ZodType<TContext>;
  tools?: AgentDefinition<TModel>["tools"];
  maxSteps?: number;
  temperature?: number;
  maxTokens?: number;
  reasoning?: AgentDefinition<TModel>["reasoning"];
  outputSchema?: z.ZodType<TOutput>;
  outputMode?: AgentDefinition<TModel, TContext, TOutput>["outputMode"];
  outputName?: string;
  outputDescription?: string;
  toolExecution?: AgentDefinition<TModel>["toolExecution"];
  toolApprovalPolicy?: AgentDefinition<TModel, TContext, TOutput>["toolApprovalPolicy"];
  toolApprovalSigner?: AgentDefinition<TModel>["toolApprovalSigner"];
  inputGuardrails?: AgentDefinition<TModel, TContext, TOutput>["inputGuardrails"];
  outputGuardrails?: AgentDefinition<TModel, TContext, TOutput>["outputGuardrails"];
  providerOptions?: AgentDefinition<TModel>["providerOptions"];
  subagents?: AgentDefinition<TModel>["subagents"];
  harness?: AgentDefinition<TModel>["harness"];
  executionEnvironment?: AgentDefinition<TModel, TContext>["executionEnvironment"];
  compaction?: AgentDefinition<TModel, TContext>["compaction"];
  policy?: AgentRunPolicy;
  metadata?: Record<string, JsonValue>;
  store?: AgentRunStore;
  memory?: AgentDefinition<TModel>["memory"];
  onTelemetryEvent?: AgentDefinition<TModel>["onTelemetryEvent"];
  hookFailurePolicy?: AgentDefinition<TModel>["hookFailurePolicy"];

  constructor(definition: AgentDefinition<TModel, TContext, TOutput>) {
    Object.assign(this, createAgent(definition));
    this.model = definition.model;
  }

  toDefinition(): AgentDefinition<TModel, TContext, TOutput> {
    return createAgent<TModel, TContext, TOutput>({
      id: this.id,
      name: this.name,
      model: this.model,
      instructions: this.instructions,
      contextSchema: this.contextSchema,
      tools: this.tools,
      maxSteps: this.maxSteps,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      reasoning: this.reasoning,
      outputSchema: this.outputSchema,
      outputMode: this.outputMode,
      outputName: this.outputName,
      outputDescription: this.outputDescription,
      toolExecution: this.toolExecution,
      toolApprovalPolicy: this.toolApprovalPolicy,
      toolApprovalSigner: this.toolApprovalSigner,
      inputGuardrails: this.inputGuardrails,
      outputGuardrails: this.outputGuardrails,
      providerOptions: this.providerOptions,
      subagents: this.subagents,
      harness: this.harness,
      executionEnvironment: this.executionEnvironment,
      compaction: this.compaction,
      policy: this.policy,
      metadata: this.metadata,
      store: this.store,
      memory: this.memory,
      onTelemetryEvent: this.onTelemetryEvent,
      hookFailurePolicy: this.hookFailurePolicy
    });
  }

  run(input: AgentRunInput<TModel, TContext> = {}): Promise<AgentRunOutput<TOutput>> {
    return runAgent<TModel, TContext, TOutput>(this.toDefinition(), input);
  }

  resume(
    input: AgentRunInput<TModel, TContext> & { state: AgentRunState }
  ): Promise<AgentRunOutput<TOutput>> {
    return resumeAgent<TModel, TContext, TOutput>(this.toDefinition(), input);
  }

  stream(input: AgentRunInput<TModel, TContext> = {}): AgentStreamResult<TOutput> {
    return streamAgent<TModel, TContext, TOutput>(this.toDefinition(), input);
  }
}

export const prepareSubagentsForAgent = <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  options: PrepareSubagentsForAgentOptions = {}
): AgentDefinition<TModel> => {
  const store = options.store ?? agent.store;
  const memory = options.memory ?? agent.memory;
  const onTelemetryEvent = options.onTelemetryEvent ?? agent.onTelemetryEvent;
  const toolApprovalPolicy = options.toolApprovalPolicy ?? agent.toolApprovalPolicy;
  const toolExecution = options.toolExecution ?? agent.toolExecution;
  const executionEnvironment = options.executionEnvironment ?? agent.executionEnvironment;
  const compaction = options.compaction ?? agent.compaction;
  const defaultMetadata = cloneMetadata(agent.metadata, options.metadata);

  return {
    ...agent,
    metadata: cloneMetadata(agent.metadata),
    subagents: (agent.subagents ?? []).map((subagent) => ({
      ...subagent,
      metadata: cloneMetadata(defaultMetadata, subagent.metadata),
      agent: {
        ...subagent.agent,
        store: subagent.agent.store ?? store,
        memory: subagent.agent.memory ?? memory,
        onTelemetryEvent: subagent.agent.onTelemetryEvent ?? onTelemetryEvent,
        toolApprovalPolicy: subagent.agent.toolApprovalPolicy ?? toolApprovalPolicy,
        toolExecution: subagent.agent.toolExecution ?? toolExecution,
        executionEnvironment: subagent.agent.executionEnvironment ?? executionEnvironment,
        compaction: subagent.agent.compaction ?? compaction,
        metadata: cloneMetadata(defaultMetadata, subagent.agent.metadata)
      }
    }))
  };
};

export const runAgentGroup = async (
  agents: AgentGroupMember[],
  input: AgentGroupRunInput = {}
): Promise<AgentGroupRunOutput> => {
  const { stopOnError, runId: _runId, state: _state, approvals: _approvals, handoff: _handoff, ...sharedInput } = input;
  const parentRunId = input.parentRunId;
  const controllers = agents.map(() => new AbortController());
  let failFastTriggered = false;
  const isFailingOutput = (output: AgentRunOutput) => output.status === "failed" || output.status === "timed_out";
  const abortPending = (currentIndex: number) => {
    if (!stopOnError || failFastTriggered) {
      return;
    }
    failFastTriggered = true;
    controllers.forEach((controller, index) => {
      if (index !== currentIndex) {
        controller.abort();
      }
    });
  };

  const runs = agents.map(async (member, index) => {
    const merged = createMergedAbortSignal(
      input.abortSignal,
      member.input?.abortSignal,
      controllers[index]!.signal
    );
    try {
      const runInput = {
        ...sharedInput,
        ...(member.input ?? {}),
        parentRunId: member.input?.parentRunId ?? parentRunId,
        abortSignal: merged.signal,
        metadata: cloneMetadata(input.metadata, member.input?.metadata, {
          ...(member.name ? { agentGroupMember: member.name } : {})
        })
      } as AgentRunInput;
      const output = await runAgent(member.agent, runInput);
      if (isFailingOutput(output)) {
        abortPending(index);
      }
      return output;
    } catch (error) {
      abortPending(index);
      throw error;
    } finally {
      merged.cleanup();
    }
  });
  const settled = await Promise.allSettled(runs);
  const outputs = settled.map((result, index) => {
    const member = agents[index]!;
    if (result.status === "fulfilled") {
      return {
        name: member.name,
        agentId: result.value.state.agentId ?? member.agent.id,
        status: "fulfilled" as const,
        output: result.value
      };
    }

    return {
      name: member.name,
      agentId: member.agent.id,
      status: "rejected" as const,
      error: {
        message:
          stopOnError && failFastTriggered && controllers[index]!.signal.aborted
            ? AGENT_GROUP_FAIL_FAST_ABORT_MESSAGE
            : result.reason instanceof Error
              ? result.reason.message
              : String(result.reason)
      }
    };
  });
  const failed = outputs.some(
    (output) => output.status === "rejected" || output.output?.status === "failed" || output.output?.status === "timed_out"
  );

  return {
    status: stopOnError && failed ? "failed" : failed ? "failed" : "completed",
    parentRunId,
    outputs
  };
};

export const cancelAgentRun = async (
  store: AgentRunStore,
  runId: string,
  options: AgentRunCancellationOptions = {}
): Promise<AgentRunState | undefined> => {
  const loadedState = await store.load(runId, options.scope);
  if (!loadedState) {
    return undefined;
  }

  const cancelledAt = Date.now();
  const status = options.mode === "final" ? "cancelled" : "cancel_requested";
  const state = normalizeAgentRunState({
    ...loadedState,
    status,
    cancelledAt,
    cancellationReason: options.reason,
    updatedAt: cancelledAt,
    error: undefined
  });
  await saveStateWithRevision(store, state);
  return cloneState(state);
};

export const cancelAgentRunTree = async (
  store: AgentRunStore,
  runId: string,
  options: AgentRunCancellationOptions = {}
): Promise<AgentRunTreeCancellationResult> => {
  if (!store.findByParentRunId) {
    throw new ValidationError('The agent run "store" must implement "findByParentRunId()" to cancel an agent run tree.');
  }

  const cancelledAt = Date.now();
  const status = options.mode === "final" ? "cancelled" : "cancel_requested";
  const cancelState = (state: AgentRunState): AgentRunState =>
    normalizeAgentRunState({
      ...state,
      status,
      cancelledAt,
      cancellationReason: options.reason,
      updatedAt: cancelledAt,
      error: undefined
    });

  const parent = await store.load(runId, options.scope);
  if (!parent) {
    return {
      parent: undefined,
      children: []
    };
  }

  const visited = new Set<string>([runId]);
  const children: AgentRunState[] = [];
  const collectChildren = async (parentRunId: string): Promise<void> => {
    const directChildren = await store.findByParentRunId?.(parentRunId, options.scope);
    for (const child of directChildren ?? []) {
      if (visited.has(child.runId)) {
        continue;
      }
      visited.add(child.runId);
      children.push(child);
      await collectChildren(child.runId);
    }
  };

  await collectChildren(runId);

  const cancelledParent = cancelState(parent);
  const cancelledChildren = children.map(cancelState);
  await saveStateWithRevision(store, cancelledParent);
  for (const child of cancelledChildren) {
    await saveStateWithRevision(store, child);
  }

  return {
    parent: cloneState(cancelledParent),
    children: cancelledChildren.map(cloneState)
  };
};

export const runAgent = async <
  TModel extends LanguageModel,
  TContext = unknown,
  TOutput = unknown
>(
  agent: AgentDefinition<TModel, TContext, TOutput>,
  input: AgentRunInput<TModel, TContext> = {}
): Promise<AgentRunOutput<TOutput>> => {
  const invocationStartedAt = Date.now();
  const telemetryRunId = input.runId ?? input.state?.runId ?? randomId("run");
  const invocationInput = input.runId || input.state
    ? input
    : { ...input, runId: telemetryRunId };
  let invocationStatus: AgentStatus = "completed";
  let invocationError: Error | undefined;
  const returnInvocationOutput = (output: AgentRunOutput<TOutput>): AgentRunOutput<TOutput> => {
    invocationStatus = output.status;
    if (output.status === "failed" || output.status === "timed_out") {
      invocationError = new Error(output.error?.message ?? `Agent invocation ${output.status}.`);
      if (output.status === "timed_out") invocationError.name = "TimeoutError";
    } else {
      invocationError = undefined;
    }
    return output;
  };
  await emitInvocationStartTelemetry(
    agent,
    telemetryRunId,
    invocationStartedAt,
    Math.max(1, input.maxSteps ?? input.state?.maxSteps ?? agent.maxSteps ?? 1)
  );

  try {
  const context = await resolveContext(agent, invocationInput);
  const currentStatus = normalizeApprovalStatus(context.state.status);
  const policy = resolveRunPolicy(agent, input);

  if (
    currentStatus === "completed" ||
    currentStatus === "cancelled" ||
    currentStatus === "cancel_requested" ||
    currentStatus === "timed_out"
  ) {
    context.state.status = currentStatus;
    invocationStatus = currentStatus;
    return returnInvocationOutput(toOutput(context.state));
  }

  if (currentStatus === "waiting_approval" && context.state.pendingApprovals.length > 0) {
    context.state.status = currentStatus;
    invocationStatus = currentStatus;
    return returnInvocationOutput(toOutput(context.state));
  }

  const supportsLeases = Boolean(
    agent.store?.acquireLease && agent.store.renewLease && agent.store.releaseLease
  );
  if (!context.fresh && currentStatus === "running" && !supportsLeases) {
    invocationStatus = currentStatus;
    return returnInvocationOutput(toOutput(context.state));
  }

  const freshRequiresExistingClaim = context.fresh && Boolean(context.state.idempotencyKey);
  if (context.fresh && !freshRequiresExistingClaim) {
    await claimAgentExecution(agent, context.state);
  }
  const executionLease = await acquireAgentExecutionLease(agent, context.state, policy);
  if (!executionLease) {
    if (input.state) {
      throw new ConflictError(`Agent run "${context.state.runId}" is already owned by another worker.`);
    }
    const activeState = await agent.store?.load(context.state.runId, context.state.scope);
    const outputState = activeState ? normalizeAgentRunState(activeState) : context.state;
    invocationStatus = outputState.status;
    return returnInvocationOutput(toOutput(outputState));
  }
  try {
    if (!context.fresh || freshRequiresExistingClaim) {
      await claimAgentExecution(agent, context.state);
    }
    await emitRunStartTelemetry(agent, context.state, context.memoryMessages, input.approvals, invocationStartedAt);
  } catch (error) {
    await executionLease.release();
    throw error;
  }

  if (context.remainingSteps === 0) {
    const state = createFailedState(context.state, "Agent exhausted maxSteps before reaching a terminal response.");
    await persistState(agent, state, policy);
    await emitRunFinishTelemetry(agent, state);
    await executionLease.release();
    return returnInvocationOutput(toOutput(state));
  }

  let inputGuardrail: AgentGuardrailTrigger | undefined;
  try {
    inputGuardrail = await runGuardrails(agent, context.state, "input", agent.inputGuardrails, () => ({
      runId: context.state.runId,
      agentId: context.state.agentId,
      context: context.context,
      state: cloneState(context.state),
      messages: context.messages,
      metadata: context.state.metadata
    }));
  } catch (error) {
    await executionLease.release();
    throw error;
  }
  if (inputGuardrail) {
    const failedState = applyGuardrailFailure(context.state, "input", inputGuardrail);
    await persistState(agent, failedState, policy);
    await emitRunFinishTelemetry(agent, failedState);
    await executionLease.release();
    return returnInvocationOutput(toOutput(failedState));
  }

  const abortContext = createAgentAbortContext(input.abortSignal, policy, executionLease.signal);
  let executionEnvironmentSession: AgentExecutionEnvironmentSession<TContext> | undefined;
  let executionEnvironmentStatus: AgentStatus = "failed";
  let executionEnvironmentError: { message: string } | undefined;
  try {
    executionEnvironmentSession = await acquireExecutionEnvironment(
      context.executionEnvironment,
      context.state,
      context.context,
      abortContext.signal
    );
  } catch (error) {
    abortContext.cleanup();
    await executionLease.release();
    throw error;
  }

  try {
    const result = await withAgentTelemetryRunContext(
      agent,
      context.state.runId,
      () => withAgentPolicyTimeout(
        generateText(
          createGenerateOptions(
            agent,
            context.state,
            input,
            context.messages,
            context.remainingSteps,
            context.context,
            executionEnvironmentSession,
            abortContext.signal
          )
        ),
        abortContext
      )
    );
    const cancelled = executionLease.cancelledState();
    if (cancelled) {
      executionEnvironmentStatus = cancelled.status;
      await emitRunFinishTelemetry(agent, cancelled);
      return returnInvocationOutput(toOutput(cancelled));
    }
    if (executionLease.leaseLost()) {
      throw new ConflictError(`Agent run "${context.state.runId}" lost its worker lease.`);
    }
    const newSteps = mapSteps(result.steps, context.state.currentStep, result.toolResults);
    let output = finalizeState(agent, context.state, result, newSteps, result.toolResults);

    const outputGuardrail = await runGuardrails(agent, output.state, "output", agent.outputGuardrails, () => ({
      runId: output.state.runId,
      agentId: output.state.agentId,
      context: context.context,
      state: cloneState(output.state),
      output,
      metadata: output.state.metadata
    }));
    if (outputGuardrail) {
      output = toOutput(applyGuardrailFailure(output.state, "output", outputGuardrail));
    }

    await emitFinalizedStepTelemetry(agent, output.state, newSteps);
    await emitApprovalTelemetry(agent, output.state, [
      ...(result.approvalRequests ?? []),
      ...approvalsFromEvents(newSteps.flatMap((step) => step.response?.messages ?? []))
    ]);
    await persistState(agent, output.state, policy);
    await emitRunFinishTelemetry(agent, output.state);

    executionEnvironmentStatus = output.status;
    return returnInvocationOutput(output);
  } catch (error) {
    executionEnvironmentError = {
      message: error instanceof Error ? error.message : String(error)
    };
    const cancelled = executionLease.cancelledState();
    if (cancelled) {
      executionEnvironmentStatus = cancelled.status;
      await emitRunFinishTelemetry(agent, cancelled);
      return returnInvocationOutput(toOutput(cancelled));
    }
    if (executionLease.leaseLost()) {
      throw new ConflictError(`Agent run "${context.state.runId}" lost its worker lease.`);
    }
    if (error instanceof AgentPolicyTimeoutError || abortContext.isTimedOut()) {
      const status = policy?.onTimeout === "cancel-requested" ? "cancel_requested" : "timed_out";
      const message = error instanceof Error ? error.message : `Agent run timed out after ${policy?.timeoutMs}ms.`;
      const durableState = agent.store
        ? normalizeAgentRunState((await agent.store.load(context.state.runId, context.state.scope)) ?? context.state)
        : context.state;
      const timedOutState = createTerminalState(durableState, status, message);
      await persistState(agent, timedOutState, policy);
      await emitRunFinishTelemetry(agent, timedOutState);
      executionEnvironmentStatus = timedOutState.status;
      return returnInvocationOutput(toOutput(timedOutState));
    }

    const durableState = agent.store
      ? normalizeAgentRunState((await agent.store.load(context.state.runId, context.state.scope)) ?? context.state)
      : context.state;
    const failedState = createFailedState(
      durableState,
      error instanceof Error ? error.message : String(error)
    );
    await persistState(agent, failedState, policy);
    await emitRunFinishTelemetry(agent, failedState);
    executionEnvironmentStatus = failedState.status;
    throw error;
  } finally {
    await executionEnvironmentSession?.release?.({
      status: executionEnvironmentStatus,
      error: executionEnvironmentError
    });
    await executionLease.release();
  }
  } catch (error) {
    invocationStatus = "failed";
    invocationError = error instanceof Error ? error : new Error(String(error));
    throw error;
  } finally {
    await emitInvocationFinishTelemetry(agent, telemetryRunId, invocationStatus, invocationError);
  }
};

export const streamAgent = <
  TModel extends LanguageModel,
  TContext = unknown,
  TOutput = unknown
>(
  agent: AgentDefinition<TModel, TContext, TOutput>,
  input: AgentRunInput<TModel, TContext> = {}
): AgentStreamResult<TOutput> => {
  const invocationStartedAt = Date.now();
  const telemetryRunId = input.runId ?? input.state?.runId ?? randomId("run");
  const invocationInput = input.runId || input.state
    ? input
    : { ...input, runId: telemetryRunId };
  const policy = resolveRunPolicy(agent, input);
  const broadcast = new BoundedReplayBroadcast<AgentStreamEvent>({
    maxHistory: policy?.maxStreamEvents ?? 4096
  });
  const publish = (event: AgentStreamEvent, terminal = false) =>
    broadcast.publish(event, { terminal });
  let activeLease: AgentExecutionLeaseContext | undefined;
  let activeExecutionEnvironment: AgentExecutionEnvironmentSession<TContext> | undefined;
  let invocationFinishPromise: Promise<void> | undefined;
  const finishInvocation = (status: AgentStatus, error?: Error) => {
    invocationFinishPromise ??= emitInvocationFinishTelemetry(agent, telemetryRunId, status, error);
    return invocationFinishPromise;
  };

  const runner = (async () => {
    await emitInvocationStartTelemetry(
      agent,
      telemetryRunId,
      invocationStartedAt,
      Math.max(1, input.maxSteps ?? input.state?.maxSteps ?? agent.maxSteps ?? 1)
    );
    const context = await resolveContext(agent, invocationInput);
    const currentStatus = normalizeApprovalStatus(context.state.status);

    const supportsLeases = Boolean(
      agent.store?.acquireLease && agent.store.renewLease && agent.store.releaseLease
    );
    if (!context.fresh && currentStatus === "running" && !supportsLeases) {
      broadcast.close();
      await finishInvocation(currentStatus);
      return {
        output: toOutput(context.state),
        textStream: emptyAsyncIterable()
      };
    }

    if (
      currentStatus === "completed" ||
      currentStatus === "cancelled" ||
      currentStatus === "cancel_requested" ||
      currentStatus === "timed_out"
    ) {
      context.state.status = currentStatus;
      broadcast.close();
      await finishInvocation(currentStatus);
      return {
        output: toOutput(context.state),
        textStream: emptyAsyncIterable()
      };
    }

    if (currentStatus === "waiting_approval" && context.state.pendingApprovals.length > 0) {
      context.state.status = currentStatus;
      broadcast.close();
      await finishInvocation(currentStatus);
      return {
        output: toOutput(context.state),
        textStream: emptyAsyncIterable()
      };
    }

    const freshRequiresExistingClaim = context.fresh && Boolean(context.state.idempotencyKey);
    if (context.fresh && !freshRequiresExistingClaim) {
      await claimAgentExecution(agent, context.state);
    }
    const executionLease = await acquireAgentExecutionLease(agent, context.state, policy);
    if (!executionLease) {
      if (input.state) {
        throw new ConflictError(`Agent run "${context.state.runId}" is already owned by another worker.`);
      }
      const activeState = await agent.store?.load(context.state.runId, context.state.scope);
      broadcast.close();
      const outputState = activeState ? normalizeAgentRunState(activeState) : context.state;
      await finishInvocation(outputState.status);
      return {
        output: toOutput(outputState),
        textStream: emptyAsyncIterable()
      };
    }
    activeLease = executionLease;
    try {
      if (!context.fresh || freshRequiresExistingClaim) {
        await claimAgentExecution(agent, context.state);
      }
      await emitRunStartTelemetry(agent, context.state, context.memoryMessages, input.approvals, invocationStartedAt);
    } catch (error) {
      await executionLease.release();
      throw error;
    }

    if (context.remainingSteps === 0) {
      const state = createFailedState(context.state, "Agent exhausted maxSteps before reaching a terminal response.");
      await persistState(agent, state, policy);
      await emitRunFinishTelemetry(agent, state);
      await executionLease.release();
      broadcast.close();
      await finishInvocation(state.status);
      return {
        output: toOutput(state),
        textStream: emptyAsyncIterable()
      };
    }

    let inputGuardrail: AgentGuardrailTrigger | undefined;
    try {
      inputGuardrail = await runGuardrails(agent, context.state, "input", agent.inputGuardrails, () => ({
        runId: context.state.runId,
        agentId: context.state.agentId,
        context: context.context,
        state: cloneState(context.state),
        messages: context.messages,
        metadata: context.state.metadata
      }));
    } catch (error) {
      await executionLease.release();
      throw error;
    }
    if (inputGuardrail) {
      const failedState = applyGuardrailFailure(context.state, "input", inputGuardrail);
      await persistState(agent, failedState, policy);
      await emitRunFinishTelemetry(agent, failedState);
      await publish({
        type: "error",
        error: new GuardrailTriggeredError("input", failedState.error?.message ?? "Agent input guardrail triggered.", {
          metadata: inputGuardrail.metadata
        })
      }, true);
      await publish({
        type: "agent-run-finish",
        status: failedState.status,
        state: failedState
      }, true);
      broadcast.close();
      await executionLease.release();
      await finishInvocation(failedState.status);
      return {
        output: toOutput(failedState),
        textStream: emptyAsyncIterable()
      };
    }

    await publish({
      type: "agent-run-start",
      currentStep: context.state.currentStep + 1,
      maxSteps: context.state.maxSteps
    });

    for (const approval of input.approvals ?? []) {
      await publish({
        type: "agent-approval-resolved",
        approval
      });
    }

    await publish({
      type: "agent-step-start",
      stepIndex: context.state.currentStep + 1
    });

    const abortContext = createAgentAbortContext(input.abortSignal, policy, executionLease.signal);
    let executionEnvironmentSession: AgentExecutionEnvironmentSession<TContext> | undefined;
    try {
      executionEnvironmentSession = await acquireExecutionEnvironment(
        context.executionEnvironment,
        context.state,
        context.context,
        abortContext.signal
      );
    } catch (error) {
      abortContext.cleanup();
      await executionLease.release();
      throw error;
    }
    activeExecutionEnvironment = executionEnvironmentSession;
    let executionEnvironmentStatus: AgentStatus = "failed";
    let executionEnvironmentError: { message: string } | undefined;
    let streamResult: ReturnType<typeof streamText>;
    try {
      streamResult = streamText(
        createGenerateOptions(
          agent,
          context.state,
          input,
          context.messages,
          context.remainingSteps,
          context.context,
          executionEnvironmentSession,
          abortContext.signal,
          async (record) => {
            await publish({
              type: "agent-compaction",
              compaction: record
            });
          }
        )
      );
    } catch (error) {
      abortContext.cleanup();
      executionEnvironmentError = {
        message: error instanceof Error ? error.message : String(error)
      };
      await executionEnvironmentSession?.release?.({
        status: "failed",
        error: executionEnvironmentError
      });
      activeExecutionEnvironment = undefined;
      await executionLease.release();
      throw error;
    }
    const approvalRequests: AgentApprovalRequest[] = [];

    const eventRelay = withAgentTelemetryRunContext(agent, context.state.runId, async () => {
      for await (const event of streamResult.eventStream) {
        await publish(event);

        if (event.type === "tool-approval-request") {
          approvalRequests.push(event.approval);
          await publish({
            type: "agent-approval-request",
            approval: event.approval
          });
          await emitTelemetryEvent(agent, {
            type: "approval-request",
            runId: context.state.runId,
            agentId: context.state.agentId,
            approval: event.approval
          });
        }

        if (
          event.type === "provider-data" &&
          typeof event.data === "object" &&
          event.data !== null &&
          !Array.isArray(event.data) &&
          event.data.type === "mcp_approval_request" &&
          typeof event.data.id === "string" &&
          typeof event.data.name === "string" &&
          typeof event.data.arguments === "string"
        ) {
          const approval = {
            provider: event.provider,
            id: event.data.id,
            name: event.data.name,
            arguments: event.data.arguments,
            serverLabel: typeof event.data.server_label === "string" ? event.data.server_label : undefined,
            rawData: event.data
          } satisfies AgentApprovalRequest;
          approvalRequests.push(approval);
          await publish({
            type: "agent-approval-request",
            approval
          });
          await emitTelemetryEvent(agent, {
            type: "approval-request",
            runId: context.state.runId,
            agentId: context.state.agentId,
            approval
          });
        }
      }
    });

    const output = (async () => {
      try {
        const final = await withAgentPolicyTimeout(
          eventRelay.then(() => streamResult.collect()),
          abortContext
        );
        const cancelled = executionLease.cancelledState();
        if (cancelled) {
          executionEnvironmentStatus = cancelled.status;
          await emitRunFinishTelemetry(agent, cancelled);
          await publish({
            type: "agent-run-finish",
            status: cancelled.status,
            state: cancelled
          }, true);
          broadcast.close();
          return toOutput(cancelled);
        }
        if (executionLease.leaseLost()) {
          const conflict = new ConflictError(`Agent run "${context.state.runId}" lost its worker lease.`);
          broadcast.fail(conflict);
          throw conflict;
        }
        const newSteps = mapSteps(final.steps, context.state.currentStep, final.toolResults);
        let result = finalizeState(agent, context.state, final, newSteps, final.toolResults);

        const outputGuardrail = await runGuardrails(agent, result.state, "output", agent.outputGuardrails, () => ({
          runId: result.state.runId,
          agentId: result.state.agentId,
          context: context.context,
          state: cloneState(result.state),
          output: result,
          metadata: result.state.metadata
        }));
        if (outputGuardrail) {
          result = toOutput(applyGuardrailFailure(result.state, "output", outputGuardrail));
          await publish({
            type: "error",
            error: new GuardrailTriggeredError(
              "output",
              result.state.error?.message ?? "Agent output guardrail triggered.",
              { metadata: outputGuardrail.metadata }
            )
          }, true);
        }

        for (const step of newSteps) {
          await publish({
            type: "agent-step-finish",
            step
          });
        }

        await emitFinalizedStepTelemetry(agent, result.state, newSteps);
        if (!approvalRequests.length) {
          await emitApprovalTelemetry(agent, result.state, approvalsFromEvents(newSteps.flatMap((step) => step.response?.messages ?? [])));
        }
        await persistState(agent, result.state, policy);
        await emitRunFinishTelemetry(agent, result.state);

        await publish({
          type: "agent-run-finish",
          status: result.status,
          state: result.state
        }, true);
        broadcast.close();
        executionEnvironmentStatus = result.status;
        return result;
      } catch (error) {
        executionEnvironmentError = {
          message: error instanceof Error ? error.message : String(error)
        };
        const cancelled = executionLease.cancelledState();
        if (cancelled) {
          executionEnvironmentStatus = cancelled.status;
          await emitRunFinishTelemetry(agent, cancelled);
          await publish({
            type: "agent-run-finish",
            status: cancelled.status,
            state: cancelled
          }, true);
          broadcast.close();
          return toOutput(cancelled);
        }
        if (executionLease.leaseLost()) {
          const conflict = new ConflictError(`Agent run "${context.state.runId}" lost its worker lease.`);
          broadcast.fail(conflict);
          throw conflict;
        }
        if (error instanceof AgentPolicyTimeoutError || abortContext.isTimedOut()) {
          const status = policy?.onTimeout === "cancel-requested" ? "cancel_requested" : "timed_out";
          const message = error instanceof Error ? error.message : `Agent run timed out after ${policy?.timeoutMs}ms.`;
          const durableState = agent.store
            ? normalizeAgentRunState((await agent.store.load(context.state.runId, context.state.scope)) ?? context.state)
            : context.state;
          const timedOutState = createTerminalState(durableState, status, message);
          await persistState(agent, timedOutState, policy);
          await emitRunFinishTelemetry(agent, timedOutState);
          await publish({
            type: "error",
            error: new AgentPolicyTimeoutError(policy?.timeoutMs ?? 0)
          }, true);
          await publish({
            type: "agent-run-finish",
            status: timedOutState.status,
            state: timedOutState
          }, true);
          broadcast.close();
          executionEnvironmentStatus = timedOutState.status;
          return toOutput(timedOutState);
        }

        const durableState = agent.store
          ? normalizeAgentRunState((await agent.store.load(context.state.runId, context.state.scope)) ?? context.state)
          : context.state;
        const failedState = createFailedState(durableState, error instanceof Error ? error.message : String(error));
        await persistState(agent, failedState, policy);
        await emitRunFinishTelemetry(agent, failedState);
        await publish({
          type: "error",
          error: error instanceof Error ? error : new Error(String(error))
        }, true);
        await publish({
          type: "agent-run-finish",
          status: failedState.status,
          state: failedState
        }, true);
        broadcast.close();
        executionEnvironmentStatus = failedState.status;
        throw error;
      } finally {
        await executionEnvironmentSession?.release?.({
          status: executionEnvironmentStatus,
          error: executionEnvironmentError
        });
        activeExecutionEnvironment = undefined;
        await executionLease.release();
      }
    })().finally(() => finishInvocation(
      executionEnvironmentStatus,
      executionEnvironmentError ? new Error(executionEnvironmentError.message) : undefined
    ));

    return {
      output,
      textStream: streamResult.textStream
    };
  })().catch(async (error) => {
    await finishInvocation("failed", error instanceof Error ? error : new Error(String(error)));
    await activeExecutionEnvironment?.release?.({
      status: "failed",
      error: { message: error instanceof Error ? error.message : String(error) }
    });
    activeExecutionEnvironment = undefined;
    await activeLease?.release();
    broadcast.fail(error);
    throw error;
  });

  return {
    eventStream: broadcast.stream(),
    textStream: (async function* () {
      const started = await runner;
      for await (const chunk of started.textStream) {
        yield chunk;
      }
    })(),
    collect: async () => (await runner).output as AgentRunOutput<TOutput>
  };
};

export const resumeAgent = async <
  TModel extends LanguageModel,
  TContext = unknown,
  TOutput = unknown
>(
  agent: AgentDefinition<TModel, TContext, TOutput>,
  input: AgentRunInput<TModel, TContext> & { state: AgentRunState }
): Promise<AgentRunOutput<TOutput>> => runAgent<TModel, TContext, TOutput>(agent, input);
