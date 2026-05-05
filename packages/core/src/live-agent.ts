import { GuardrailTriggeredError, ValidationError } from "./errors.js";
import { normalizeMessages } from "./generate-text.js";
import { createTextMessage, getTextFromParts, isCallableToolDefinition, serializeJsonValue, toolResultPart } from "./messages.js";
import { toToolSet } from "./tool-registry.js";
import type {
  AgentGuardrailTrigger,
  AgentInputGuardrail,
  AgentLiveEvent,
  AgentLiveStreamResult,
  AgentOutputGuardrail,
  AgentRunState,
  AgentStatus,
  AgentTelemetryEvent,
  JsonValue,
  LiveAgentDefinition,
  LiveAgentRunInput,
  LiveAgentRunOutput,
  ModelMessage,
  RealtimeEvent,
  RealtimeModel,
  RealtimeSession,
  RealtimeSessionConfig,
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolCall,
  ToolCollection,
  ToolDefinition,
  ToolExecutionOptions,
  ToolExecutionResult
} from "./types.js";

const randomId = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
const AGENT_RUN_STATE_SCHEMA_VERSION = 1;

const joinInstructions = (...parts: Array<string | undefined>): string | undefined => {
  const content = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  return content.length ? content.join("\n\n") : undefined;
};

const cloneMetadata = (...values: Array<Record<string, JsonValue> | undefined>) => {
  const merged = Object.assign({}, ...values.filter(Boolean));
  return Object.keys(merged).length ? merged : undefined;
};

const normalizeRunState = (state: AgentRunState): AgentRunState => ({
  ...state,
  schemaVersion: AGENT_RUN_STATE_SCHEMA_VERSION
});

const cloneState = (state: AgentRunState): AgentRunState =>
  JSON.parse(JSON.stringify(normalizeRunState(state))) as AgentRunState;

const createBaseState = (
  provider: string,
  modelId: string,
  initialMessages: ModelMessage[],
  metadata: Record<string, JsonValue> | undefined,
  agentId: string | undefined,
  runId: string
): AgentRunState => {
  const startedAt = Date.now();
  return {
    schemaVersion: AGENT_RUN_STATE_SCHEMA_VERSION,
    runId,
    agentId,
    provider,
    modelId,
    status: "running",
    messages: initialMessages,
    steps: [],
    toolResults: [],
    currentStep: 0,
    maxSteps: 1,
    outputText: "",
    pendingApprovals: [],
    metadata,
    startedAt,
    updatedAt: startedAt
  };
};

const createFailedState = (state: AgentRunState, message: string): AgentRunState => ({
  ...state,
  status: "failed",
  error: { message },
  updatedAt: Date.now()
});

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

const emitTelemetryEvent = async <TModel extends RealtimeModel>(
  agent: LiveAgentDefinition<TModel>,
  event: AgentTelemetryEvent
) => {
  await agent.onTelemetryEvent?.(event);
};

const persistState = async <TModel extends RealtimeModel>(agent: LiveAgentDefinition<TModel>, state: AgentRunState) => {
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

const runGuardrails = async <TRequest>(
  agent: Pick<LiveAgentDefinition<RealtimeModel>, "onTelemetryEvent" | "id">,
  state: AgentRunState,
  stage: "input" | "output",
  guardrails: ReadonlyArray<((request: TRequest) => AgentGuardrailTrigger | void | Promise<AgentGuardrailTrigger | void>)> | undefined,
  requestFactory: (index: number) => TRequest
) => {
  for (const [index, guardrail] of (guardrails ?? []).entries()) {
    const trigger = await guardrail(requestFactory(index));
    if (!trigger?.triggered) {
      continue;
    }

    await agent.onTelemetryEvent?.({
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

const emitRunStartTelemetry = async <TModel extends RealtimeModel>(
  agent: LiveAgentDefinition<TModel>,
  state: AgentRunState,
  memoryMessages: ModelMessage[]
) => {
  await emitTelemetryEvent(agent, {
    type: "run-start",
    runId: state.runId,
    agentId: state.agentId,
    provider: state.provider,
    modelId: state.modelId,
    maxSteps: state.maxSteps
  });
  if (memoryMessages.length) {
    await emitTelemetryEvent(agent, {
      type: "memory-loaded",
      runId: state.runId,
      agentId: state.agentId,
      messageCount: memoryMessages.length
    });
  }
};

const emitRunFinishTelemetry = async <TModel extends RealtimeModel>(agent: LiveAgentDefinition<TModel>, state: AgentRunState) => {
  await emitTelemetryEvent(agent, {
    type: "run-finish",
    runId: state.runId,
    agentId: state.agentId,
    status: state.status,
    state: cloneState(state)
  });
};

const withToolTimeout = async <T>(operation: Promise<T>, timeoutMs?: number): Promise<T> => {
  if (!timeoutMs) {
    return operation;
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tool execution timed out after ${timeoutMs}ms.`)), timeoutMs);
    operation
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
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

const textFromMessage = (message: ModelMessage) => getTextFromParts(message.parts).trim();

const createResult = (state: AgentRunState): LiveAgentRunOutput => ({
  status: state.status,
  outputText: state.outputText,
  messages: state.messages,
  toolResults: state.toolResults,
  state,
  error: state.error
});

const createBroadcast = <TEvent>() => {
  const subscribers = new Set<(value: IteratorResult<TEvent>) => void>();
  const history: IteratorResult<TEvent>[] = [];
  let done = false;

  const publish = (value: IteratorResult<TEvent>) => {
    history.push(value);
    for (const subscriber of subscribers) {
      subscriber(value);
    }
    if (value.done) {
      done = true;
    }
  };

  const stream = async function* () {
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

      await new Promise<IteratorResult<TEvent>>((resolve) => {
        const subscriber = (value: IteratorResult<TEvent>) => {
          subscribers.delete(subscriber);
          resolve(value);
        };
        subscribers.add(subscriber);
      });
    }
  };

  return {
    publish,
    stream
  };
};

const resolveApproval = async <TModel extends RealtimeModel>(options: {
  agent: LiveAgentDefinition<TModel>;
  input: LiveAgentRunInput;
  state: AgentRunState;
  call: ToolCall;
  parsedInput: JsonValue;
  tool: ToolDefinition;
  realtimeConfig: RealtimeSessionConfig;
}): Promise<ToolApprovalDecision> => {
  const policy = options.input.toolApprovalPolicy ?? options.agent.toolApprovalPolicy;
  const request: ToolApprovalRequest = {
    toolCall: options.call,
    tool: options.tool,
    input: options.parsedInput,
    step: 1,
    model: options.agent.model,
    realtimeConfig: options.realtimeConfig
  };

  const decision =
    !policy
      ? options.tool.requiresApproval
        ? {
            approved: false,
            reason: `Tool "${options.call.name}" requires approval, but no toolApprovalPolicy is configured.`
          }
        : { approved: true }
      : await policy(request);

  const normalized =
    typeof decision === "boolean"
      ? {
          approved: decision,
          reason: decision ? undefined : `Tool "${options.call.name}" was denied by the approval policy.`
        }
      : (decision ?? { approved: true });

  await emitTelemetryEvent(options.agent, {
    type: "tool-approval",
    runId: options.state.runId,
    agentId: options.state.agentId,
    toolCall: options.call,
    approved: normalized.approved,
    reason: normalized.reason,
    metadata: normalized.metadata
  });

  return normalized;
};

export const streamLiveAgent = <TModel extends RealtimeModel>(
  agent: LiveAgentDefinition<TModel>,
  input: LiveAgentRunInput = {}
): AgentLiveStreamResult => {
  const broadcast = createBroadcast<AgentLiveEvent>();
  let resolveSession!: (session: RealtimeSession) => void;
  let rejectSession!: (error: unknown) => void;
  const sessionPromise = new Promise<RealtimeSession>((resolve, reject) => {
    resolveSession = resolve;
    rejectSession = reject;
  });

  const runner = (async () => {
    const runId = input.runId ?? randomId("run");
    const metadata = cloneMetadata(agent.metadata, input.metadata);
    const memoryMessages = agent.memory
      ? await agent.memory.load({
          runId,
          agentId: agent.id,
          metadata
        })
      : [];

    let messages = normalizeMessages({
      prompt: input.prompt,
      messages: input.messages,
      system: joinInstructions(agent.instructions, input.system)
    });
    messages = injectContextMessages(messages, memoryMessages);

    const state = createBaseState(agent.model.provider, agent.model.modelId, messages, metadata, agent.id, runId);
    await emitRunStartTelemetry(agent, state, memoryMessages);
    broadcast.publish({
      done: false,
      value: {
        type: "agent-run-start",
        currentStep: 1,
        maxSteps: 1
      }
    });

    const inputGuardrail = await runGuardrails(
      agent,
      state,
      "input",
      agent.inputGuardrails as AgentInputGuardrail[] | undefined,
      () => ({
        runId: state.runId,
        agentId: state.agentId,
        messages,
        metadata: state.metadata
      })
    );
    if (inputGuardrail) {
      const failedState = applyGuardrailFailure(state, "input", inputGuardrail);
      await persistState(agent, failedState);
      await emitRunFinishTelemetry(agent, failedState);
      const error = new GuardrailTriggeredError("input", failedState.error?.message ?? "Agent input guardrail triggered.", {
        metadata: inputGuardrail.metadata
      });
      broadcast.publish({ done: false, value: { type: "error", error } });
      broadcast.publish({
        done: false,
        value: {
          type: "agent-run-finish",
          status: failedState.status,
          state: failedState
        }
      });
      broadcast.publish({ done: true, value: undefined });
      rejectSession(error);
      return createResult(failedState);
    }

    const resolvedTools = {
      ...(toToolSet(agent.tools) ?? {}),
      ...(toToolSet(input.tools) ?? {})
    };
    const realtimeConfig: RealtimeSessionConfig = {
      autoResponse: true,
      ...input.realtime,
      instructions: joinInstructions(agent.instructions, input.system, input.realtime?.instructions),
      tools: Object.keys(resolvedTools).length ? resolvedTools : undefined,
      toolChoice: input.toolChoice ?? input.realtime?.toolChoice ?? agent.toolChoice,
      providerOptions: {
        ...(agent.providerOptions ?? {}),
        ...(input.providerOptions ?? {}),
        ...(input.realtime?.providerOptions ?? {})
      }
    };

    let session: RealtimeSession | undefined;
    let sessionError: Error | undefined;
    let transcript = [...messages];
    const toolResults: ToolExecutionResult[] = [];
    const assistantBuffer: string[] = [];
    let finalText = "";

    try {
      session = await agent.model.connect(realtimeConfig, input.connectOptions);
      resolveSession(session);

      if (input.messages) {
        for (const message of input.messages) {
          if (message.role !== "user") {
            continue;
          }
          const text = textFromMessage(message);
          if (text) {
            await session.sendText(text);
          }
        }
      } else if (input.prompt) {
        await session.sendText(input.prompt);
      }

      for await (const event of session.eventStream()) {
        broadcast.publish({ done: false, value: event });

        if (event.type === "realtime-text-delta") {
          assistantBuffer.push(event.textDelta);
          broadcast.publish({
            done: false,
            value: {
              type: "text-delta",
              textDelta: event.textDelta
            }
          });
          continue;
        }

        if (event.type === "realtime-transcript") {
          if (event.role === "user" && event.isFinal && event.text) {
            transcript.push(createTextMessage("user", event.text));
          }
          if (event.role === "assistant" && event.isFinal) {
            const text = event.text || assistantBuffer.join("");
            if (text) {
              finalText = text;
              transcript.push(createTextMessage("assistant", text));
              assistantBuffer.length = 0;
            }
          }
          continue;
        }

        if (event.type === "realtime-tool-call") {
          broadcast.publish({
            done: false,
            value: {
              type: "tool-call",
              toolCall: event.toolCall
            }
          });

          const definition = resolvedTools[event.toolCall.name];
          if (!definition) {
            const result = {
              toolCallId: event.toolCall.id,
              toolName: event.toolCall.name,
              error: { message: `Tool "${event.toolCall.name}" is not registered.` },
              isError: true
            } satisfies ToolExecutionResult;
            toolResults.push(result);
            transcript.push({
              role: "tool",
              parts: [toolResultPart(result)]
            });
            await session.sendToolResult(result);
            continue;
          }

          if (!isCallableToolDefinition(definition)) {
            const result = {
              toolCallId: event.toolCall.id,
              toolName: event.toolCall.name,
              error: { message: `Tool "${event.toolCall.name}" is provider-hosted and cannot be executed locally.` },
              isError: true
            } satisfies ToolExecutionResult;
            toolResults.push(result);
            transcript.push({
              role: "tool",
              parts: [toolResultPart(result)]
            });
            await session.sendToolResult(result);
            continue;
          }

          const parsed = definition.schema.safeParse(event.toolCall.input);
          if (!parsed.success) {
            const result = {
              toolCallId: event.toolCall.id,
              toolName: event.toolCall.name,
              error: { message: `Invalid input for tool "${event.toolCall.name}": ${parsed.error.message}` },
              isError: true
            } satisfies ToolExecutionResult;
            toolResults.push(result);
            transcript.push({
              role: "tool",
              parts: [toolResultPart(result)]
            });
            await session.sendToolResult(result);
            continue;
          }

          const approval = await resolveApproval({
            agent,
            input,
            state,
            call: event.toolCall,
            parsedInput: serializeJsonValue(parsed.data),
            tool: definition,
            realtimeConfig
          });
          if (!approval.approved) {
            const result = {
              toolCallId: event.toolCall.id,
              toolName: event.toolCall.name,
              error: {
                message: approval.reason ?? `Tool "${event.toolCall.name}" was denied by the approval policy.`
              },
              isError: true
            } satisfies ToolExecutionResult;
            toolResults.push(result);
            transcript.push({
              role: "tool",
              parts: [toolResultPart(result)]
            });
            await session.sendToolResult(result);
            continue;
          }

          try {
            const output = serializeJsonValue(
              await withToolTimeout(
                Promise.resolve(definition.execute(parsed.data)),
                (input.toolExecution ?? agent.toolExecution)?.timeoutMs
              )
            );
            const result = {
              toolCallId: event.toolCall.id,
              toolName: event.toolCall.name,
              output,
              isError: false
            } satisfies ToolExecutionResult;
            toolResults.push(result);
            transcript.push({
              role: "tool",
              parts: [toolResultPart(result)]
            });
            await session.sendToolResult(result);
          } catch (error) {
            const result = {
              toolCallId: event.toolCall.id,
              toolName: event.toolCall.name,
              error: { message: error instanceof Error ? error.message : "Tool execution failed." },
              isError: true
            } satisfies ToolExecutionResult;
            toolResults.push(result);
            transcript.push({
              role: "tool",
              parts: [toolResultPart(result)]
            });
            await session.sendToolResult(result);
          }
          continue;
        }

        if (event.type === "realtime-error") {
          sessionError = event.error ?? new Error(event.message ?? "Realtime session failed.");
          continue;
        }

        if (event.type === "realtime-end" && event.reason === "error") {
          sessionError ??= new Error(
            typeof event.providerMetadata?.message === "string" ? event.providerMetadata.message : "Realtime session failed."
          );
        }

        if (event.type === "realtime-response-complete" || event.type === "realtime-end") {
          break;
        }
      }

      if (sessionError) {
        throw sessionError;
      }

      if (assistantBuffer.length && !finalText) {
        finalText = assistantBuffer.join("");
        if (finalText) {
          transcript.push(createTextMessage("assistant", finalText));
        }
      }

      state.messages = transcript;
      state.toolResults = toolResults;
      state.outputText = finalText;
      state.status = "completed";
      state.updatedAt = Date.now();
      state.error = undefined;

      const result = createResult(state);
      const outputGuardrail = await runGuardrails(
        agent,
        state,
        "output",
        agent.outputGuardrails as AgentOutputGuardrail[] | undefined,
        () => ({
          runId: state.runId,
          agentId: state.agentId,
          state: cloneState(state),
          output: result,
          metadata: state.metadata
        })
      );
      const finalState = outputGuardrail ? applyGuardrailFailure(state, "output", outputGuardrail) : state;
      if (outputGuardrail) {
        broadcast.publish({
          done: false,
          value: {
            type: "error",
            error: new GuardrailTriggeredError("output", finalState.error?.message ?? "Agent output guardrail triggered.", {
              metadata: outputGuardrail.metadata
            })
          }
        });
      }

      await persistState(agent, finalState);
      await emitRunFinishTelemetry(agent, finalState);
      broadcast.publish({
        done: false,
        value: {
          type: "agent-run-finish",
          status: finalState.status,
          state: finalState
        }
      });
      broadcast.publish({ done: true, value: undefined });
      return createResult(finalState);
    } catch (error) {
      if (!session) {
        rejectSession(error);
      }
      const failedState = createFailedState(state, error instanceof Error ? error.message : String(error));
      await persistState(agent, failedState);
      await emitRunFinishTelemetry(agent, failedState);
      broadcast.publish({
        done: false,
        value: {
          type: "error",
          error: error instanceof Error ? error : new Error(String(error))
        }
      });
      broadcast.publish({
        done: false,
        value: {
          type: "agent-run-finish",
          status: failedState.status,
          state: failedState
        }
      });
      broadcast.publish({ done: true, value: undefined });
      throw error;
    } finally {
      if (session) {
        await session.close();
      }
    }
  })();

  return {
    eventStream: broadcast.stream(),
    textStream: (async function* () {
      for await (const event of broadcast.stream()) {
        if (event.type === "text-delta") {
          yield event.textDelta;
        }
      }
    })(),
    session: sessionPromise,
    collect: () => runner
  };
};
