import { childStateObserver, loadFailureState, runCheckpoints, observeChildState, projectChildRun, reconcileChildRuns, upsertChildRun } from "./children.js";
import { validateMaxSteps } from "../validate-max-steps.js";
import {
  createRunViewSink,
  runViewSink,
  runViewParent,
  type ObservedAgent
} from "../agent-run-view.js";
import {
  createHash
} from "node:crypto";
import {
  getAgentApprovalRequests
} from "../agent-approval.js";
import {
  fingerprintAgentHarness
} from "../agent-harness.js";
import {
  normalizeAgentRunState
} from "../agent-state.js";
import {
  BoundedReplayBroadcast
} from "../bounded-broadcast.js";
import {
  ConflictError,
  GuardrailTriggeredError,
  ValidationError
} from "../errors.js";
import {
  aggregateTokenUsage,
  generateText,
  getGenerateTextStepTiming,
  streamText
} from "../generate-text.js";
import {
  isCallableToolDefinition,
  serializeJsonValue
} from "../messages.js";
import {
  evaluateAgentBudgetPreflight,
  getAgentBudgetStatus
} from "../safety-policy.js";
import {
  ToolExecutionSuspendedError
} from "../tool-execution-suspension.js";
import {
  toToolSet
} from "../tool-registry.js";
import {
  z
} from "zod";
import type {
  AgentCompactionRecord,
  AgentApprovalRequest,
  AgentDefinition,
  AgentExecutionEnvironmentSession,
  AgentGuardrailTrigger,
  AgentRunInput,
  AgentRunOutput,
  AgentRunState,
  AgentStep,
  AgentStatus,
  AgentStreamEvent,
  AgentStreamResult,
  CreateSubAgentToolOptions,
  GenerateTextOptions,
  JsonValue,
  LanguageModel,
  ModelMessage,
  SubAgentToolInput,
  SubAgentToolOutput,
  ToolDefinition
} from "../types.js";
import {
  approvalsFromEvents,
  cloneMetadata,
  cloneState,
  createFailedState,
  createTerminalState,
  joinInstructions,
  mapSteps,
  messagePrefixLength,
  normalizeApprovalStatus,
  randomId,
  resolveAgentOutputMode,
  snapshotRequest,
  snapshotResponse,
  toOutput
} from "./common.js";
import {
  AgentPolicyTimeoutError,
  acquireAgentExecutionLease,
  createAgentAbortContext,
  resolveRunPolicy,
  type AgentExecutionLeaseContext,
  withAgentPolicyTimeout
} from "./lifecycle.js";
import {
  claimAgentExecution,
  finalizeState,
  persistState
} from "./state.js";
import {
  resolveContext
} from "./context.js";
import {
  emitApprovalTelemetry,
  emitFinalizedStepTelemetry,
  emitInvocationFinishTelemetry,
  emitInvocationStartTelemetry,
  emitRunFinishTelemetry,
  emitRunStartTelemetry,
  emitTelemetryEvent,
  emitToolApprovalTelemetry,
  withAgentTelemetryRunContext
} from "./telemetry.js";
import {
  applyGuardrailFailure,
  runGuardrails
} from "./guardrails.js";
import {
  acquireExecutionEnvironment,
  durableToolCallId,
  wrapToolWithExecutionEnvironment,
  wrapToolWithJournal
} from "./tool-execution.js";
import {
  compactAgentMessages
} from "./compaction.js";

const subAgentToolInputSchema = z.object({
  prompt: z.string().min(1),
  system: z.string().optional()
});

const defaultSubAgentToolName = (agent: AgentDefinition): string => {
  const id = agent.id ?? `${agent.model.provider}_${agent.model.modelId}`;
  const normalized = id.replace(/[^A-Za-z0-9_]+/g, "_");
  let start = 0;
  let end = normalized.length;
  // Scan the edges once to avoid regex backtracking on long underscore runs.
  while (start < end && normalized[start] === "_") start++;
  while (end > start && normalized[end - 1] === "_") end--;
  return `subagent_${normalized.slice(start, end) || "agent"}`;
};

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
      if (toolCallId) childMetadata.subagentToolCallId = toolCallId;
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
      let latestState: AgentRunState | undefined;
      const observedAgent = {
        ...options.agent,
        [childStateObserver]: (childState: AgentRunState) => {
          latestState = childState;
          if (runtimeState) upsertChildRun(runtimeState, projectChildRun(childState));
        }
      };
      let output: AgentRunOutput;
      try {
        output = checkpoint?.resumeState
        ? await resumeAgent(observedAgent, {
            state: checkpoint.resumeState,
            approvals: childApprovalResponses,
            scope: options.scope,
            context: executionContext?.context,
            abortSignal: executionContext?.abortSignal,
            maxSteps: options.maxSteps
          })
        : await runAgent(observedAgent, {
            prompt: input.prompt,
            system: joinInstructions(options.system, input.system),
            parentRunId: options.parentRunId,
            idempotencyKey: childIdempotencyKey,
            scope: options.scope,
            context: executionContext?.context,
            abortSignal: executionContext?.abortSignal,
            maxSteps: options.maxSteps,
            metadata: cloneMetadata(options.metadata, childMetadata)
          });
      } catch (error) {
        if (latestState) {
          if (latestState.status === "running") {
            latestState = createFailedState(latestState, error);
            try { await persistState(observedAgent, latestState); } catch { /* preserve primary error */ }
          }
          // Terminal notification must never replace the original execution error.
          try { await options.onFinish?.(projectChildRun(latestState)); } catch { /* preserve primary error */ }
        }
        throw error;
      }
      const childRun = projectChildRun(output.state);
      childRun.toolName = toolName;
      childRun.toolCallId = toolCallId;
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

const createGenerateOptions = <
  TModel extends LanguageModel,
  TContext,
  TOutput,
  TContextInput
>(
  agent: AgentDefinition<TModel, TContext, TOutput, TContextInput>,
  state: AgentRunState,
  input: AgentRunInput<TModel, TContext, NoInfer<TContextInput>>,
  messages: ModelMessage[],
  maxSteps: number,
  context: TContext | undefined,
  executionEnvironmentSession: AgentExecutionEnvironmentSession<TContext> | undefined,
  abortSignal: AbortSignal | undefined = input.abortSignal,
  onCompaction?: (record: AgentCompactionRecord) => void | Promise<void>
): GenerateTextOptions<TModel, TContext> => {
  const tools = { ...(toToolSet(input.tools ?? agent.tools) ?? {}) };
  state.childRuns ??= [];
  for (const subagent of agent.subagents ?? []) {
    const subagentTool = createSubAgentTool({
      ...subagent,
      agent: {
        ...subagent.agent,
        ...((agent as ObservedAgent)[runViewSink] ? { [runViewSink]: (agent as ObservedAgent)[runViewSink], [runViewParent]: state.runId } : {}),
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
        upsertChildRun(state, childRun);
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
  let liveUsage = state.usage;
  const liveToolResults = [...state.toolResults];
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
  const toolExecution = agent.subagents?.length && !(requestedToolExecution?.parallel && requestedToolExecution.independentOnly)
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
          // Finalization adds this invocation's model usage. Only add the
          // compactor here; checkpoint usage already includes model responses.
          state.usage = aggregateTokenUsage([state.usage, compacted.record.usage]);
          liveUsage = aggregateTokenUsage([liveUsage, compacted.record.usage]);
          state.compactions = checkpointState.compactions;
          await persistState(agent, checkpointState, runPolicy);
          state.revision = checkpointState.revision;
          await onCompaction?.(compacted.record);
          return compacted.messages;
        }
      : undefined,
    onBeforeModelStep: async ({ step }) => {
      if (budget) {
        const trigger = evaluateAgentBudgetPreflight({ ...state, usage: liveUsage, toolResults: liveToolResults }, budget, {
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
    onModelStep: async ({ request, response, step, toolCalls, approvalRequests, failedToolResults }) => {
      liveUsage = aggregateTokenUsage([liveUsage, response.usage]);
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
        status: failedToolResults ? "failed" : approvals.length ? "waiting_approval" : "completed",
        startedAt: timing?.startedAt ?? finishedAt,
        finishedAt,
        request: snapshotRequest(request, requestOffset, request.messages.slice(requestOffset)),
        response: responseSnapshot,
        toolResults: failedToolResults ?? []
      } satisfies AgentStep;
      checkpointState = {
        ...checkpointState,
        status: approvals.length ? "waiting_approval" : toolCalls.length ? "running" : "completed",
        messages: [...request.messages, ...responseSnapshot.messages,
          ...(failedToolResults ?? []).map(toolResult => ({ role: "tool" as const, parts: [{ type: "tool-result" as const, toolResult }] }))],
        toolResults: [...checkpointState.toolResults, ...(failedToolResults ?? [])],
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
      runCheckpoints.set(state, checkpointState);
      observeChildState(agent, checkpointState);
      if (agent.store) {
        await persistState(agent, checkpointState, runPolicy);
        state.revision = checkpointState.revision;
      }
      if (failedToolResults) Object.assign(state, checkpointState);
    },
    onToolExecutionComplete: async ({ toolResults }) => {
      liveToolResults.push(...toolResults);
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
      runCheckpoints.set(state, checkpointState);
      observeChildState(agent, checkpointState);
      if (agent.store) {
        await persistState(agent, checkpointState, runPolicy);
        state.revision = checkpointState.revision;
      }
    },
    stepOffset: state.currentStep,
    onBeforeToolExecution: async ({ step, toolCalls }) => {
      if (budget) {
        reservedToolCalls += toolCalls.length;
        const trigger = evaluateAgentBudgetPreflight({ ...state, usage: liveUsage, toolResults: liveToolResults }, budget, {
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
    streamBuffer: input.streamBuffer ?? agent.streamBuffer,
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

export const runAgent = async <
  TModel extends LanguageModel,
  TContext = unknown,
  TOutput = unknown,
  TContextInput = TContext
>(
  agent: AgentDefinition<TModel, TContext, TOutput, TContextInput>,
  input: AgentRunInput<TModel, TContext, NoInfer<TContextInput>> = {}
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
    validateMaxSteps(input.maxSteps ?? input.state?.maxSteps ?? agent.maxSteps)
  );

  try {
  const context = await resolveContext(agent, invocationInput);
  await reconcileChildRuns(context.state, agent.store);
  observeChildState(agent, context.state);
  const currentStatus = normalizeApprovalStatus(context.state.status);
  if (!context.fresh && currentStatus === "failed" && input.idempotencyKey && childStateObserver in agent) {
    throw new Error(context.state.error?.message ?? "Subagent previously failed.");
  }
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
    // Failure recovery must retain terminal guardrail transformations too.
    runCheckpoints.set(context.state, output.state);

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
    output.taskOutcome = output.state.taskOutcome;
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
      const durableState = await loadFailureState(context.state, agent.store);
      const timedOutState = createTerminalState(durableState, status, message);
      await persistState(agent, timedOutState, policy);
      await emitRunFinishTelemetry(agent, timedOutState);
      executionEnvironmentStatus = timedOutState.status;
      return returnInvocationOutput(toOutput(timedOutState));
    }

    const durableState = await loadFailureState(context.state, agent.store);
    const failedState = createFailedState(durableState, error);
    try { await persistState(agent, failedState, policy); } catch { /* preserve primary error */ }
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
  TOutput = unknown,
  TContextInput = TContext
>(
  agent: AgentDefinition<TModel, TContext, TOutput, TContextInput>,
  input: AgentRunInput<TModel, TContext, NoInfer<TContextInput>> = {}
): AgentStreamResult<TOutput> => {
  const invocationStartedAt = Date.now();
  const telemetryRunId = input.runId ?? input.state?.runId ?? randomId("run");
  const invocationInput = input.runId || input.state
    ? input
    : { ...input, runId: telemetryRunId };
  const policy = resolveRunPolicy(agent, input);
  const broadcast = new BoundedReplayBroadcast<AgentStreamEvent>({
    ...(input.streamBuffer ?? agent.streamBuffer),
    maxHistory: policy?.maxStreamEvents ?? input.streamBuffer?.maxHistory ?? agent.streamBuffer?.maxHistory ?? 4096
  });
  let viewReady = false;
  const pendingViews = new Map<string, import("../types.js").AgentRunView>();
  const publish = async (event: AgentStreamEvent, terminal = false) => {
    await broadcast.publish(event, { terminal });
    if (event.type === "agent-run-start") {
      viewReady = true;
      for (const run of pendingViews.values()) await broadcast.publish({ type: "agent-run-update", run });
      pendingViews.clear();
    }
  };
  agent = { ...agent, policy: { ...agent.policy, ...input.policy },
    [runViewParent]: input.parentRunId ?? input.state?.parentRunId,
    [runViewSink]: createRunViewSink(async run => {
      if (broadcast.isClosed) return;
      if (!viewReady) { pendingViews.set(run.runId, run); return; }
      await publish({ type: "agent-run-update", run });
    })
  } as typeof agent;
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
      validateMaxSteps(input.maxSteps ?? input.state?.maxSteps ?? agent.maxSteps)
    );
    const context = await resolveContext(agent, invocationInput);
    await reconcileChildRuns(context.state, agent.store);
    observeChildState(agent, context.state);
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
        runCheckpoints.set(context.state, result.state);

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
        result.taskOutcome = result.state.taskOutcome;
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
          const durableState = await loadFailureState(context.state, agent.store);
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

        const durableState = await loadFailureState(context.state, agent.store);
        const failedState = createFailedState(durableState, error);
        try { await persistState(agent, failedState, policy); } catch { /* preserve primary error */ }
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
  TOutput = unknown,
  TContextInput = TContext
>(
  agent: AgentDefinition<TModel, TContext, TOutput, TContextInput>,
  input: AgentRunInput<TModel, TContext, NoInfer<TContextInput>> & { state: AgentRunState }
): Promise<AgentRunOutput<TOutput>> => runAgent<TModel, TContext, TOutput, TContextInput>(agent, input);
