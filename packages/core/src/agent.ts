import { createAgentApprovalMessage, getAgentApprovalRequests } from "./agent-approval.js";
import { ValidationError } from "./errors.js";
import { generateText, normalizeMessages, streamText } from "./generate-text.js";
import type {
  AgentApprovalResponse,
  AgentDefinition,
  AgentStreamEvent,
  AgentRunInput,
  AgentRunOutput,
  AgentRunState,
  AgentStep,
  AgentStepRequest,
  AgentStepResponse,
  AgentStreamResult,
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

    return {
      index: offset + index + 1,
      status: "completed",
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

const createBaseState = (
  provider: string,
  modelId: string,
  initialMessages: ModelMessage[],
  maxSteps: number,
  metadata?: Record<string, JsonValue>,
  agentId?: string
): AgentRunState => ({
  agentId,
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
  metadata
});

const ensureValidStateInput = (input: AgentRunInput) => {
  if (input.approvals?.length && !input.state) {
    throw new ValidationError('The "approvals" option requires an existing agent "state".');
  }

  if (!input.state) {
    return;
  }

  if (input.prompt !== undefined || input.messages !== undefined || input.system !== undefined) {
    throw new ValidationError('Pass either "state" or a fresh "prompt"/"messages" input, but not both.');
  }
};

const prepareFreshMessages = <TModel extends AgentDefinition["model"]>(
  agent: AgentDefinition<TModel>,
  input: AgentRunInput<TModel>
) =>
  normalizeMessages({
    prompt: input.prompt,
    messages: input.messages,
    system: joinInstructions(agent.instructions, input.system)
  });

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
  const pendingApprovals = getAgentApprovalRequests(
    newSteps.flatMap((step) => step.response?.messages ?? [])
  );

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

  return toOutput(state);
};

const resolveContext = <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  input: AgentRunInput<TModel>
) => {
  ensureValidStateInput(input);

  const metadata = cloneMetadata(agent.metadata, input.state?.metadata, input.metadata);
  if (input.state) {
    const maxSteps = input.maxSteps ?? input.state.maxSteps;
    const resumed = applyApprovalResponses(input.state.messages, input.approvals, input.state.pendingApprovals);
    return {
      state: {
        ...input.state,
        agentId: input.state.agentId ?? agent.id,
        provider: agent.model.provider,
        modelId: agent.model.modelId,
        maxSteps,
        messages: resumed.messages,
        pendingApprovals: resumed.pendingApprovals,
        metadata
      } satisfies AgentRunState,
      messages: resumed.messages,
      remainingSteps: Math.max(0, maxSteps - input.state.currentStep)
    };
  }

  const maxSteps = Math.max(1, input.maxSteps ?? agent.maxSteps ?? 1);
  const initialMessages = prepareFreshMessages(agent, input);

  return {
    state: createBaseState(agent.model.provider, agent.model.modelId, initialMessages, maxSteps, metadata, agent.id),
    messages: initialMessages,
    remainingSteps: maxSteps
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
  const context = resolveContext(agent, input);

  if (context.state.status === "completed" || context.state.status === "cancelled") {
    return toOutput(context.state);
  }

  if (context.state.status === "suspended" && context.state.pendingApprovals.length > 0 && !input.approvals?.length) {
    return toOutput(context.state);
  }

  if (context.remainingSteps === 0) {
    const state: AgentRunState = {
      ...context.state,
      status: "failed",
      error: { message: "Agent exhausted maxSteps before reaching a terminal response." }
    };
    return toOutput(state);
  }

  const result = await generateText(createGenerateOptions(agent, input, context.messages, context.remainingSteps));
  const newSteps = mapSteps(result.steps, context.state.currentStep, result.toolResults);

  return finalizeState(context.state, result, newSteps, result.toolResults);
};

export const streamAgent = <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  input: AgentRunInput<TModel> = {}
): AgentStreamResult => {
  const context = resolveContext(agent, input);

  if (context.state.status === "completed" || context.state.status === "cancelled") {
    return {
      eventStream: emptyAsyncIterable(),
      textStream: emptyAsyncIterable(),
      collect: async () => toOutput(context.state)
    };
  }

  if (context.state.status === "suspended" && context.state.pendingApprovals.length > 0 && !input.approvals?.length) {
    return {
      eventStream: emptyAsyncIterable(),
      textStream: emptyAsyncIterable(),
      collect: async () => toOutput(context.state)
    };
  }

  if (context.remainingSteps === 0) {
    const state: AgentRunState = {
      ...context.state,
      status: "failed",
      error: { message: "Agent exhausted maxSteps before reaching a terminal response." }
    };

    return {
      eventStream: emptyAsyncIterable(),
      textStream: emptyAsyncIterable(),
      collect: async () => toOutput(state)
    };
  }

  const result = streamText(createGenerateOptions(agent, input, context.messages, context.remainingSteps));
  const subscribers = new Set<(value: IteratorResult<AgentStreamEvent>) => void>();
  const history: IteratorResult<AgentStreamEvent>[] = [];
  let done = false;
  let finalResultPromise: Promise<AgentRunOutput> | undefined;

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

  const runner = async (): Promise<AgentRunOutput> => {
    publish({
      done: false,
      value: {
        type: "agent-run-start",
        currentStep: context.state.currentStep + 1,
        maxSteps: context.state.maxSteps
      }
    });

    if (input.approvals?.length) {
      for (const approval of input.approvals) {
        publish({
          done: false,
          value: {
            type: "agent-approval-resolved",
            approval
          }
        });
      }
    }

    publish({
      done: false,
      value: {
        type: "agent-step-start",
        stepIndex: context.state.currentStep + 1
      }
    });

    try {
      for await (const event of result.eventStream) {
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
          publish({
            done: false,
            value: {
              type: "agent-approval-request",
              approval: {
                provider: event.provider,
                id: event.data.id,
                name: event.data.name,
                arguments: event.data.arguments,
                serverLabel: typeof event.data.server_label === "string" ? event.data.server_label : undefined,
                rawData: event.data
              }
            }
          });
        }
      }

      const final = await result.collect();
      const newSteps = mapSteps(final.steps, context.state.currentStep, final.toolResults);
      const output = finalizeState(context.state, final, newSteps, final.toolResults);

      for (const step of newSteps) {
        publish({
          done: false,
          value: {
            type: "agent-step-finish",
            step
          }
        });
      }

      publish({
        done: false,
        value: {
          type: "agent-run-finish",
          status: output.status,
          state: output.state
        }
      });
      publish({ done: true, value: undefined });
      return output;
    } catch (error) {
      const failedState: AgentRunState = {
        ...context.state,
        status: "failed",
        error: {
          message: error instanceof Error ? error.message : String(error)
        }
      };

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
  };

  finalResultPromise = runner();

  return {
    eventStream: createEventStream(),
    textStream: result.textStream,
    collect: async () => finalResultPromise
  };
};

export const resumeAgent = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  input: AgentRunInput<TModel> & { state: AgentRunState }
): Promise<AgentRunOutput> => runAgent(agent, input);
