import { createAgentApprovalMessage, getAgentApprovalRequests } from "./agent-approval.js";
import { createAgentHandoffMessage } from "./agent-handoff.js";
import { ValidationError } from "./errors.js";
import { generateText, normalizeMessages, streamText } from "./generate-text.js";
import type {
  AgentApprovalRequest,
  AgentApprovalResponse,
  AgentDefinition,
  AgentRunInput,
  AgentRunOutput,
  AgentRunState,
  AgentStep,
  AgentStepRequest,
  AgentStepResponse,
  AgentStatus,
  AgentStreamEvent,
  AgentStreamResult,
  AgentTelemetryEvent,
  GenerateTextOptions,
  GenerateTextOutput,
  GenerateTextStep,
  JsonValue,
  LanguageModel,
  ModelGenerateInput,
  ModelMessage,
  ProviderOptions,
  ToolExecutionResult
} from "./types.js";

const randomId = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

const joinInstructions = (...parts: Array<string | undefined>): string | undefined => {
  const content = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  return content.length ? content.join("\n\n") : undefined;
};

const hasToolCalls = (messages: ModelMessage[]): boolean =>
  messages.some((message) => message.parts.some((part) => part.type === "tool-call"));

const snapshotRequest = (request: ModelGenerateInput): AgentStepRequest => ({
  messages: request.messages,
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

const mapSteps = (steps: GenerateTextStep[], offset: number, toolResults: ToolExecutionResult[]): AgentStep[] => {
  let toolResultCursor = 0;

  return steps.map((step, index) => {
    const response = snapshotResponse(step.response);
    const toolCallCount = countToolCalls(response.messages);
    const stepToolResults = toolResults.slice(toolResultCursor, toolResultCursor + toolCallCount);
    toolResultCursor += toolCallCount;
    const finishedAt = Date.now();

    return {
      index: offset + index + 1,
      status: "completed",
      startedAt: finishedAt,
      finishedAt,
      request: snapshotRequest(step.request),
      response,
      toolResults: stepToolResults
    };
  });
};

const cloneMetadata = (...values: Array<Record<string, JsonValue> | undefined>) => {
  const merged = Object.assign({}, ...values.filter(Boolean));
  return Object.keys(merged).length ? merged : undefined;
};

const toOutput = (state: AgentRunState): AgentRunOutput => ({
  status: state.status,
  outputText: state.outputText,
  finishReason: state.finishReason,
  providerFinishReason: state.providerFinishReason,
  usage: state.usage,
  messages: state.messages,
  steps: state.steps,
  toolResults: state.toolResults,
  state,
  error: state.error
});

const cloneState = (state: AgentRunState): AgentRunState => JSON.parse(JSON.stringify(state)) as AgentRunState;

const createBaseState = (
  provider: string,
  modelId: string,
  initialMessages: ModelMessage[],
  maxSteps: number,
  metadata: Record<string, JsonValue> | undefined,
  agentId: string | undefined,
  runId: string,
  handoff: AgentRunInput["handoff"]
): AgentRunState => {
  const startedAt = Date.now();

  return {
    runId,
    agentId,
    parentRunId: handoff?.fromRunId,
    provider,
    modelId,
    status: "running",
    messages: initialMessages,
    steps: [],
    toolResults: [],
    currentStep: 0,
    maxSteps,
    outputText: "",
    pendingApprovals: [],
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
    system: joinInstructions(agent.instructions, input.system)
  });

  const handoffMessages = input.handoff
    ? [createAgentHandoffMessage(input.handoff), ...input.handoff.contextMessages.filter((message) => message.role !== "system")]
    : [];
  messages = injectContextMessages(messages, handoffMessages);

  const memoryMessages = agent.memory
    ? await agent.memory.load({
        runId,
        agentId: agent.id,
        metadata: cloneMetadata(agent.metadata, input.metadata)
      })
    : [];

  messages = injectContextMessages(messages, memoryMessages);

  return {
    messages,
    memoryMessages
  };
};

const applyApprovalResponses = (
  messages: ModelMessage[],
  approvals: AgentApprovalResponse[] | undefined,
  pendingApprovals: AgentRunState["pendingApprovals"]
) => {
  if (!approvals?.length) {
    return {
      messages,
      pendingApprovals
    };
  }

  const pendingById = new Map(pendingApprovals.map((approval) => [approval.id, approval]));
  for (const approval of approvals) {
    const pending = pendingById.get(approval.approvalRequestId);
    if (!pending) {
      throw new ValidationError(`Unknown approval request "${approval.approvalRequestId}".`);
    }

    if (pending.provider !== approval.provider) {
      throw new ValidationError(
        `Approval request "${approval.approvalRequestId}" belongs to provider "${pending.provider}", not "${approval.provider}".`
      );
    }
  }

  return {
    messages: [...messages, createAgentApprovalMessage(approvals)],
    pendingApprovals: pendingApprovals.filter(
      (pending) => !approvals.some((approval) => approval.approvalRequestId === pending.id)
    )
  };
};

const finalizeState = (
  state: AgentRunState,
  result: GenerateTextOutput,
  newSteps: AgentStep[],
  newToolResults: ToolExecutionResult[]
): AgentRunOutput => {
  const nextCurrentStep = state.currentStep + newSteps.length;
  const exhausted = nextCurrentStep >= state.maxSteps;
  const lastStep = newSteps.at(-1);
  const unresolvedToolCalls = lastStep?.response ? hasToolCalls(lastStep.response.messages) : false;
  const pendingApprovals = getAgentApprovalRequests(newSteps.flatMap((step) => step.response?.messages ?? []));

  if (pendingApprovals.length) {
    state.status = "suspended";
    state.error = undefined;
    if (lastStep) {
      lastStep.status = "suspended";
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
  state.finishReason = result.finishReason;
  state.providerFinishReason = result.providerFinishReason;
  state.usage = result.usage;
  state.pendingApprovals = pendingApprovals;
  state.updatedAt = Date.now();

  return toOutput(state);
};

const emitTelemetryEvent = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  event: AgentTelemetryEvent
) => {
  await agent.onTelemetryEvent?.(event);
};

const persistState = async <TModel extends LanguageModel>(agent: AgentDefinition<TModel>, state: AgentRunState) => {
  state.updatedAt = Date.now();
  await agent.store?.save(cloneState(state));
  await emitTelemetryEvent(agent, {
    type: "state-saved",
    runId: state.runId,
    agentId: state.agentId,
    status: state.status
  });
  await agent.memory?.save?.({
    runId: state.runId,
    agentId: state.agentId,
    state: cloneState(state),
    metadata: state.metadata
  });
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

const resolveContext = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  input: AgentRunInput<TModel>
) => {
  let loadedState = input.state;
  if (!loadedState && input.runId && agent.store) {
    loadedState = await agent.store.load(input.runId);
  }

  const normalizedInput = loadedState ? { ...input, state: loadedState } : input;
  ensureValidStateInput(normalizedInput);

  const metadata = cloneMetadata(agent.metadata, loadedState?.metadata, input.metadata, input.handoff?.metadata);
  if (loadedState) {
    const maxSteps = input.maxSteps ?? loadedState.maxSteps;
    const resumed = applyApprovalResponses(loadedState.messages, input.approvals, loadedState.pendingApprovals);

    return {
      state: {
        ...loadedState,
        agentId: loadedState.agentId ?? agent.id,
        provider: agent.model.provider,
        modelId: agent.model.modelId,
        maxSteps,
        messages: resumed.messages,
        pendingApprovals: resumed.pendingApprovals,
        metadata,
        updatedAt: Date.now()
      } satisfies AgentRunState,
      messages: resumed.messages,
      remainingSteps: Math.max(0, maxSteps - loadedState.currentStep),
      memoryMessages: [] as ModelMessage[]
    };
  }

  const runId = input.runId ?? randomId("run");
  const maxSteps = Math.max(1, input.maxSteps ?? agent.maxSteps ?? 1);
  const prepared = await prepareFreshMessages(agent, input, runId);

  return {
    state: createBaseState(agent.model.provider, agent.model.modelId, prepared.messages, maxSteps, metadata, agent.id, runId, input.handoff),
    messages: prepared.messages,
    remainingSteps: maxSteps,
    memoryMessages: prepared.memoryMessages
  };
};

const createGenerateOptions = <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  input: AgentRunInput<TModel>,
  messages: ModelMessage[],
  maxSteps: number
): GenerateTextOptions<TModel> => ({
  model: agent.model,
  messages,
  tools: input.tools ?? agent.tools,
  toolChoice: input.toolChoice,
  toolExecution: input.toolExecution ?? agent.toolExecution,
  maxSteps,
  temperature: input.temperature ?? agent.temperature,
  maxTokens: input.maxTokens ?? agent.maxTokens,
  reasoning: input.reasoning ?? agent.reasoning,
  providerOptions: input.providerOptions ?? agent.providerOptions,
  abortSignal: input.abortSignal,
  timeoutMs: input.timeoutMs,
  maxRetries: input.maxRetries,
  retryBackoffMs: input.retryBackoffMs
});

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

const emitRunStartTelemetry = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState,
  memoryMessages: ModelMessage[],
  approvals: AgentApprovalResponse[] | undefined
) => {
  await emitTelemetryEvent(agent, {
    type: "run-start",
    runId: state.runId,
    agentId: state.agentId,
    provider: state.provider,
    modelId: state.modelId,
    maxSteps: state.maxSteps
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
    status: state.status,
    state: cloneState(state)
  });
};

export const createAgent = <TModel extends AgentDefinition["model"]>(
  definition: AgentDefinition<TModel>
): AgentDefinition<TModel> => ({
  ...definition,
  metadata: cloneMetadata(definition.metadata)
});

export const runAgent = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  input: AgentRunInput<TModel> = {}
): Promise<AgentRunOutput> => {
  const context = await resolveContext(agent, input);
  await emitRunStartTelemetry(agent, context.state, context.memoryMessages, input.approvals);

  if (context.state.status === "completed" || context.state.status === "cancelled") {
    return toOutput(context.state);
  }

  if (context.state.status === "suspended" && context.state.pendingApprovals.length > 0 && !input.approvals?.length) {
    return toOutput(context.state);
  }

  if (context.remainingSteps === 0) {
    const state = createFailedState(context.state, "Agent exhausted maxSteps before reaching a terminal response.");
    await persistState(agent, state);
    await emitRunFinishTelemetry(agent, state);
    return toOutput(state);
  }

  await emitTelemetryEvent(agent, {
    type: "step-start",
    runId: context.state.runId,
    agentId: context.state.agentId,
    stepIndex: context.state.currentStep + 1
  });

  try {
    const result = await generateText(createGenerateOptions(agent, input, context.messages, context.remainingSteps));
    const newSteps = mapSteps(result.steps, context.state.currentStep, result.toolResults);
    const output = finalizeState(context.state, result, newSteps, result.toolResults);

    await emitFinalizedStepTelemetry(agent, output.state, newSteps);
    await emitApprovalTelemetry(agent, output.state, approvalsFromEvents(newSteps.flatMap((step) => step.response?.messages ?? [])));
    await persistState(agent, output.state);
    await emitRunFinishTelemetry(agent, output.state);

    return output;
  } catch (error) {
    const failedState = createFailedState(
      context.state,
      error instanceof Error ? error.message : String(error)
    );
    await persistState(agent, failedState);
    await emitRunFinishTelemetry(agent, failedState);
    throw error;
  }
};

export const streamAgent = <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  input: AgentRunInput<TModel> = {}
): AgentStreamResult => {
  const subscribers = new Set<(value: IteratorResult<AgentStreamEvent>) => void>();
  const history: IteratorResult<AgentStreamEvent>[] = [];
  let done = false;

  const publish = (value: IteratorResult<AgentStreamEvent>) => {
    history.push(value);
    for (const subscriber of subscribers) {
      subscriber(value);
    }
    if (value.done) {
      done = true;
    }
  };

  const createEventStream = async function* () {
    let cursor = 0;

    while (true) {
      while (cursor < history.length) {
        const item = history[cursor];
        cursor += 1;
        if (item.done) {
          return;
        }
        yield item.value;
      }

      if (done) {
        return;
      }

      await new Promise<IteratorResult<AgentStreamEvent>>((resolve) => {
        const subscriber = (value: IteratorResult<AgentStreamEvent>) => {
          subscribers.delete(subscriber);
          resolve(value);
        };
        subscribers.add(subscriber);
      });
    }
  };

  const runner = (async () => {
    const context = await resolveContext(agent, input);
    await emitRunStartTelemetry(agent, context.state, context.memoryMessages, input.approvals);

    if (context.state.status === "completed" || context.state.status === "cancelled") {
      publish({ done: true, value: undefined });
      return {
        output: toOutput(context.state),
        textStream: emptyAsyncIterable()
      };
    }

    if (context.state.status === "suspended" && context.state.pendingApprovals.length > 0 && !input.approvals?.length) {
      publish({ done: true, value: undefined });
      return {
        output: toOutput(context.state),
        textStream: emptyAsyncIterable()
      };
    }

    if (context.remainingSteps === 0) {
      const state = createFailedState(context.state, "Agent exhausted maxSteps before reaching a terminal response.");
      await persistState(agent, state);
      await emitRunFinishTelemetry(agent, state);
      publish({ done: true, value: undefined });
      return {
        output: toOutput(state),
        textStream: emptyAsyncIterable()
      };
    }

    publish({
      done: false,
      value: {
        type: "agent-run-start",
        currentStep: context.state.currentStep + 1,
        maxSteps: context.state.maxSteps
      }
    });

    for (const approval of input.approvals ?? []) {
      publish({
        done: false,
        value: {
          type: "agent-approval-resolved",
          approval
        }
      });
    }

    publish({
      done: false,
      value: {
        type: "agent-step-start",
        stepIndex: context.state.currentStep + 1
      }
    });

    await emitTelemetryEvent(agent, {
      type: "step-start",
      runId: context.state.runId,
      agentId: context.state.agentId,
      stepIndex: context.state.currentStep + 1
    });

    const streamResult = streamText(createGenerateOptions(agent, input, context.messages, context.remainingSteps));
    const approvalRequests: AgentApprovalRequest[] = [];

    const eventRelay = (async () => {
      for await (const event of streamResult.eventStream) {
        publish({ done: false, value: event });

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
          publish({
            done: false,
            value: {
              type: "agent-approval-request",
              approval
            }
          });
          await emitTelemetryEvent(agent, {
            type: "approval-request",
            runId: context.state.runId,
            agentId: context.state.agentId,
            approval
          });
        }
      }
    })();

    const output = (async () => {
      try {
        await eventRelay;
        const final = await streamResult.collect();
        const newSteps = mapSteps(final.steps, context.state.currentStep, final.toolResults);
        const result = finalizeState(context.state, final, newSteps, final.toolResults);

        for (const step of newSteps) {
          publish({
            done: false,
            value: {
              type: "agent-step-finish",
              step
            }
          });
        }

        await emitFinalizedStepTelemetry(agent, result.state, newSteps);
        if (!approvalRequests.length) {
          await emitApprovalTelemetry(agent, result.state, approvalsFromEvents(newSteps.flatMap((step) => step.response?.messages ?? [])));
        }
        await persistState(agent, result.state);
        await emitRunFinishTelemetry(agent, result.state);

        publish({
          done: false,
          value: {
            type: "agent-run-finish",
            status: result.status,
            state: result.state
          }
        });
        publish({ done: true, value: undefined });
        return result;
      } catch (error) {
        const failedState = createFailedState(context.state, error instanceof Error ? error.message : String(error));
        await persistState(agent, failedState);
        await emitRunFinishTelemetry(agent, failedState);
        publish({
          done: false,
          value: {
            type: "error",
            error: error instanceof Error ? error : new Error(String(error))
          }
        });
        publish({
          done: false,
          value: {
            type: "agent-run-finish",
            status: failedState.status,
            state: failedState
          }
        });
        publish({ done: true, value: undefined });
        throw error;
      }
    })();

    return {
      output,
      textStream: streamResult.textStream
    };
  })();

  return {
    eventStream: createEventStream(),
    textStream: (async function* () {
      const started = await runner;
      for await (const chunk of started.textStream) {
        yield chunk;
      }
    })(),
    collect: async () => (await runner).output
  };
};

export const resumeAgent = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  input: AgentRunInput<TModel> & { state: AgentRunState }
): Promise<AgentRunOutput> => runAgent(agent, input);
