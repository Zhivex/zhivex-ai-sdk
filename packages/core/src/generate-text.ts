import { createHash } from "node:crypto";

import { BoundedReplayBroadcast } from "./bounded-broadcast.js";
import {
  GuardrailTriggeredError,
  ParseError,
  ProviderToolCallError,
  UnsupportedFeatureError,
  ValidationError
} from "./errors.js";
import { emitLanguageModelTelemetryEvent } from "./middleware.js";
import {
  createTextMessage,
  getTextFromMessages,
  isCallableToolDefinition,
  normalizeFinishReason,
  providerDataPart,
  resultMessages,
  serializeJsonValue,
  toolCallPart,
  toolResultPart,
  validateMessageParts
} from "./messages.js";
import { createMergedAbortSignal } from "./runtime.js";
import { toToolSet } from "./tool-registry.js";
import { ToolExecutionSuspendedError } from "./tool-execution-suspension.js";
import type {
  GenerateResult,
  GenerateTextOptions,
  GenerateTextOutput,
  JsonValue,
  LanguageModel,
  ModelGenerateInput,
  ModelMessage,
  StreamTextResult,
  StreamEvent,
  TokenUsage,
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolCall,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult
} from "./types.js";

type AnyGenerateTextOptions = GenerateTextOptions<any, any>;

const withPossibleToolEffects = (error: unknown, effectsPossible: boolean): unknown => {
  if (!(error instanceof ProviderToolCallError) || !effectsPossible || error.effectsPossible) {
    return error;
  }

  return new ProviderToolCallError({
    provider: error.provider,
    ...(error.transport ? { transport: error.transport } : {}),
    diagnosticCode: error.diagnosticCode,
    reason: error.reason,
    retryable: false,
    effectsPossible: true,
    cause: error
  });
};

const withToolTimeout = async <T>(
  operation: (signal: AbortSignal | undefined) => Promise<T>,
  timeoutMs?: number,
  abortSignal?: AbortSignal
): Promise<T> => {
  if (!timeoutMs) {
    return operation(abortSignal);
  }

  const controller = new AbortController();
  const mergedSignal = createMergedAbortSignal(abortSignal, controller.signal);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      mergedSignal.cleanup();
      reject(new Error(`Tool execution timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    Promise.resolve()
      .then(() => operation(mergedSignal.signal))
      .then((value) => {
        clearTimeout(timer);
        mergedSignal.cleanup();
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        mergedSignal.cleanup();
        reject(error);
      });
  });
};

const validateReasoning = (options: Pick<AnyGenerateTextOptions, "model" | "reasoning">) => {
  const { reasoning } = options;
  if (!reasoning) {
    return;
  }

  if (!options.model.capabilities.reasoning) {
    throw new UnsupportedFeatureError(
      `Model "${options.model.provider}/${options.model.modelId}" does not support reasoning.`
    );
  }

  if (
    reasoning.effort === undefined &&
    reasoning.mode === undefined &&
    reasoning.context === undefined &&
    reasoning.budgetTokens === undefined &&
    reasoning.includeThoughts === undefined
  ) {
    throw new ValidationError('The "reasoning" config must include at least one supported field.');
  }

  if (
    reasoning.budgetTokens !== undefined &&
    (!Number.isInteger(reasoning.budgetTokens) || reasoning.budgetTokens <= 0)
  ) {
    throw new ValidationError('The "reasoning.budgetTokens" field must be a positive integer.');
  }

  const capabilities = options.model.capabilities;
  if (
    reasoning.effort !== undefined &&
    ((capabilities.reasoningEfforts !== undefined &&
      !capabilities.reasoningEfforts.includes(reasoning.effort)) ||
      (reasoning.effort === "max" && capabilities.reasoningEfforts === undefined))
  ) {
    throw new UnsupportedFeatureError(
      `Model "${options.model.provider}/${options.model.modelId}" does not support reasoning effort "${reasoning.effort}".`
    );
  }

  if (
    reasoning.mode !== undefined &&
    !capabilities.reasoningModes?.includes(reasoning.mode)
  ) {
    throw new UnsupportedFeatureError(
      `Model "${options.model.provider}/${options.model.modelId}" does not support reasoning mode "${reasoning.mode}".`
    );
  }

  if (
    reasoning.context !== undefined &&
    !capabilities.reasoningContexts?.includes(reasoning.context)
  ) {
    throw new UnsupportedFeatureError(
      `Model "${options.model.provider}/${options.model.modelId}" does not support reasoning context "${reasoning.context}".`
    );
  }
};

const validateInputSource = (options: Pick<AnyGenerateTextOptions, "prompt" | "messages">) => {
  if (options.prompt !== undefined && options.messages !== undefined) {
    throw new ValidationError('Pass either "prompt" or "messages", but not both.');
  }
};

const buildMessages = (options: Pick<AnyGenerateTextOptions, "prompt" | "messages" | "system">): ModelMessage[] => {
  validateInputSource(options);
  const messages = [...(options.messages ?? [])];
  if (options.system) {
    messages.unshift(createTextMessage("system", options.system));
  }
  if (options.prompt) {
    messages.push(createTextMessage("user", options.prompt));
  }
  return messages;
};

type GenerateTextStepTiming = {
  startedAt: number;
  finishedAt: number;
};

const stepTimings = new WeakMap<ModelGenerateInput, GenerateTextStepTiming>();

/** @internal Used by the agent runtime to preserve the model-call interval. */
export const getGenerateTextStepTiming = (request: ModelGenerateInput): GenerateTextStepTiming | undefined =>
  stepTimings.get(request);

export const aggregateTokenUsage = (usages: Array<TokenUsage | undefined>): TokenUsage | undefined => {
  let aggregate: TokenUsage | undefined;

  for (const usage of usages) {
    if (!usage) {
      continue;
    }

    aggregate ??= {};
    for (const field of [
      "inputTokens",
      "cachedInputTokens",
      "cacheWriteTokens",
      "outputTokens",
      "reasoningTokens",
      "totalTokens"
    ] as const) {
      if (usage[field] !== undefined) {
        aggregate[field] = (aggregate[field] ?? 0) + usage[field];
      }
    }

    if (usage.speed !== undefined) {
      aggregate.speed = usage.speed;
    }
  }

  return aggregate;
};

const toRequest = (options: AnyGenerateTextOptions, messages: ModelMessage[]): ModelGenerateInput => ({
  messages: structuredClone(messages),
  tools: toToolSet(options.tools),
  toolChoice: options.toolChoice,
  toolExecution: options.toolExecution,
  temperature: options.temperature,
  maxTokens: options.maxTokens,
  reasoning: options.reasoning,
  providerOptions: options.providerOptions,
  structuredOutput: options.structuredOutput,
  abortSignal: options.abortSignal,
  timeoutMs: options.timeoutMs,
  maxRetries: options.maxRetries,
  retryBackoffMs: options.retryBackoffMs
});

type ValidatedToolCall = {
  call: ToolCall;
  tool: ToolDefinition;
  parsedInput: unknown;
  executionContext: ToolExecutionContext;
};

type ToolPreflightResult = {
  validatedCalls: ValidatedToolCall[];
  decisions: Map<string, ToolApprovalDecision>;
  approvalRequests: NonNullable<GenerateTextOutput["approvalRequests"]>;
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

const localApprovalBinding = (
  options: AnyGenerateTextOptions,
  item: ValidatedToolCall,
  step: number
) => {
  const input = serializeJsonValue(item.parsedInput);
  const toolVersion = item.tool.approvalVersion ?? "1";
  const payload = canonicalJson({
    runId: options.toolContext?.runId ?? null,
    step,
    toolCallId: item.call.id,
    toolName: item.call.name,
    input,
    toolVersion
  });
  const inputDigest = createHash("sha256").update(payload).digest("hex");
  return {
    id: `approval_${inputDigest}`,
    input,
    inputDigest,
    payload,
    toolVersion
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

const normalizeApprovalDecision = (
  rawDecision: ToolApprovalDecision | boolean | undefined,
  toolName: string
): ToolApprovalDecision =>
  typeof rawDecision === "boolean"
    ? {
        approved: rawDecision,
        reason: rawDecision ? undefined : `Tool "${toolName}" was denied by the approval policy.`
      }
    : rawDecision ?? { approved: true };

const validateToolCalls = async (
  toolCalls: ToolCall[],
  options: AnyGenerateTextOptions,
  context: {
    request: ModelGenerateInput;
    step: number;
    tools: NonNullable<ReturnType<typeof toToolSet>>;
  }
): Promise<ValidatedToolCall[]> => {
  const validated: ValidatedToolCall[] = [];
  for (const call of toolCalls) {
    const tool = context.tools[call.name];
    if (!tool) {
      throw new ValidationError(`Tool "${call.name}" was requested by the model but is not registered.`);
    }
    if (!isCallableToolDefinition(tool)) {
      throw new ValidationError(
        `Tool "${call.name}" is provider-hosted and cannot be executed by the local tool loop.`
      );
    }
    const parsed = tool.schema.safeParse(call.input);
    if (!parsed.success) {
      throw new ValidationError(`Invalid input for tool "${call.name}": ${parsed.error.message}`);
    }
    const executionContext = {
      ...options.toolContext,
      abortSignal: context.request.abortSignal,
      toolCall: call,
      step: context.step,
      model: options.model,
      request: context.request
    } satisfies ToolExecutionContext;
    if (tool.isEnabled && !(await tool.isEnabled(parsed.data, executionContext))) {
      throw new ValidationError(`Tool "${call.name}" is disabled for this execution context.`);
    }
    validated.push({
      call,
      tool,
      parsedInput: parsed.data,
      executionContext
    });
  }
  return validated;
};

const preflightTools = async (
  toolCalls: ToolCall[],
  options: AnyGenerateTextOptions,
  context: {
    request: ModelGenerateInput;
    step: number;
    tools: NonNullable<ReturnType<typeof toToolSet>>;
  }
): Promise<ToolPreflightResult> => {
  const validatedCalls = await validateToolCalls(toolCalls, options, context);
  const decisions = new Map<string, ToolApprovalDecision>();
  const approvalRequests: NonNullable<GenerateTextOutput["approvalRequests"]> = [];

  for (const item of validatedCalls) {
    await runToolGuardrails(item, "input");
    const binding = localApprovalBinding(options, item, context.step);
    const resolution = options.toolApprovalResolutions?.find(
      (candidate) =>
        candidate.kind === "local-tool" &&
        candidate.requestId === binding.id &&
        candidate.toolCallId === item.call.id
    );

    let decision: ToolApprovalDecision;
    if (resolution) {
      if (
        resolution.inputDigest !== binding.inputDigest ||
        resolution.toolVersion !== binding.toolVersion ||
        resolution.step !== context.step
      ) {
        throw new ValidationError(`Approval request "${resolution.requestId}" no longer matches tool "${item.call.name}".`);
      }
      if (options.toolApprovalSigner) {
        if (!resolution.signature) {
          throw new ValidationError(`Approval request "${resolution.requestId}" is missing its required signature.`);
        }
        const resolutionPayload = localApprovalResolutionPayload(
          resolution.inputDigest,
          resolution.approve,
          resolution.reason
        );
        const validSignature = options.toolApprovalSigner.verify
          ? await options.toolApprovalSigner.verify(resolutionPayload, resolution.signature)
          : (await options.toolApprovalSigner.sign(resolutionPayload)) === resolution.signature;
        if (!validSignature) {
          throw new ValidationError(`Approval request "${resolution.requestId}" has an invalid signature.`);
        }
      }
      decision = {
        approved: resolution.approve,
        reason: resolution.reason
      };
    } else if (item.tool.requiresApproval && item.tool.approvalMode === "interrupt") {
      decision = {
        approved: false,
        approvalRequired: true,
        reason: `Tool "${item.call.name}" requires human approval.`
      };
    } else if (!options.toolApprovalPolicy) {
      decision = item.tool.requiresApproval
        ? {
            approved: false,
            reason: `Tool "${item.call.name}" requires approval, but no toolApprovalPolicy is configured.`
          }
        : { approved: true };
    } else {
      const approvalRequest = {
        toolCall: item.call,
        tool: item.tool,
        input: binding.input,
        step: context.step,
        model: options.model,
        request: context.request,
        executionContext: item.executionContext
      } satisfies ToolApprovalRequest;
      decision = normalizeApprovalDecision(
        await options.toolApprovalPolicy(approvalRequest),
        item.call.name
      );
    }

    const approvalRequest = {
      toolCall: item.call,
      tool: item.tool,
      input: binding.input,
      step: context.step,
      model: options.model,
      request: context.request,
      executionContext: item.executionContext
    } satisfies ToolApprovalRequest;
    if (decision.approved && decision.approvalRequired) {
      throw new ValidationError(
        `Tool approval decision for "${item.call.name}" cannot be both approved and approvalRequired.`
      );
    }
    await options.onToolApprovalDecision?.({
      request: approvalRequest,
      decision
    });

    if (decision.approvalRequired) {
      const signature = options.toolApprovalSigner
        ? await options.toolApprovalSigner.sign(binding.inputDigest)
        : undefined;
      approvalRequests.push({
        kind: "local-tool",
        provider: "zhivex",
        id: binding.id,
        name: item.call.name,
        arguments: canonicalJson(binding.input),
        toolCallId: item.call.id,
        step: context.step,
        inputDigest: binding.inputDigest,
        toolVersion: binding.toolVersion,
        signature,
        rawData: {
          type: "tool_approval_request",
          id: binding.id,
          name: item.call.name,
          arguments: canonicalJson(binding.input),
          tool_call_id: item.call.id,
          step: context.step,
          input_digest: binding.inputDigest,
          tool_version: binding.toolVersion,
          ...(signature ? { signature } : {})
        }
      });
    } else {
      decisions.set(item.call.id, decision);
    }
  }

  return {
    validatedCalls,
    decisions,
    approvalRequests
  };
};

const runToolGuardrails = async (
  item: ValidatedToolCall,
  stage: "input" | "output",
  output?: unknown
) => {
  const guardrails = stage === "input" ? item.tool.inputGuardrails : item.tool.outputGuardrails;
  for (const guardrail of guardrails ?? []) {
    const trigger = await guardrail({
      tool: item.tool,
      input: item.parsedInput,
      context: item.executionContext,
      ...(stage === "output" ? { output } : {})
    } as never);
    if (trigger?.triggered) {
      throw new GuardrailTriggeredError(
        stage === "input" ? "tool-input" : "tool-output",
        trigger.reason ?? `Tool "${item.call.name}" ${stage} guardrail triggered.`,
        { metadata: trigger.metadata }
      );
    }
  }
};

const executeTools = async (
  preflight: ToolPreflightResult,
  options: AnyGenerateTextOptions,
  context: {
    request: ModelGenerateInput;
    step: number;
  }
): Promise<ToolExecutionResult[]> => {
  const { validatedCalls, decisions } = preflight;
  const parallel = options.toolExecution?.parallel ?? options.model.capabilities.parallelToolCalls;
  const maxConcurrency = Math.max(1, options.toolExecution?.maxConcurrency ?? validatedCalls.length ?? 1);
  const timeoutMs = options.toolExecution?.timeoutMs;
  const stopOnError = options.toolExecution?.stopOnError ?? false;
  const results = new Array<ToolExecutionResult>(validatedCalls.length);

  const executeSingleTool = async (
    item: ValidatedToolCall,
    index: number
  ): Promise<void> => {
    const { call, tool } = item;
    const approval = decisions.get(call.id) ?? { approved: true };
    if (!approval.approved) {
      results[index] = {
        toolCallId: call.id,
        toolName: call.name,
        error: {
          message: approval.reason ?? `Tool "${call.name}" was denied by the approval policy.`
        },
        isError: true,
        providerMetadata: call.providerMetadata
      } satisfies ToolExecutionResult;
      return;
    }

    const startedAt = Date.now();
    await emitLanguageModelTelemetryEvent(options.model, {
      type: "tool-execution-start",
      model: options.model,
      input: context.request,
      step: context.step,
      toolCall: call,
      startedAt
    });

    try {
      // Schema and availability are deliberately rechecked immediately before
      // the side effect. Input guardrails already ran in this preflight and run
      // again when a persisted approval is resumed.
      const reparsed = tool.schema.safeParse(call.input);
      if (!reparsed.success) {
        throw new ValidationError(`Invalid input for tool "${call.name}": ${reparsed.error.message}`);
      }
      item.parsedInput = reparsed.data;
      if (tool.isEnabled && !(await tool.isEnabled(reparsed.data, item.executionContext))) {
        throw new ValidationError(`Tool "${call.name}" is disabled for this execution context.`);
      }
      const rawOutput = await withToolTimeout(
        async (abortSignal) => tool.execute(item.parsedInput, {
          ...item.executionContext,
          abortSignal
        }),
        timeoutMs,
        context.request.abortSignal
      );
      await runToolGuardrails(item, "output", rawOutput);
      const output = serializeJsonValue(rawOutput);
      const result = {
        toolCallId: call.id,
        toolName: call.name,
        output,
        isError: false,
        providerMetadata: call.providerMetadata
      } satisfies ToolExecutionResult;
      results[index] = result;

      const finishedAt = Date.now();
      await emitLanguageModelTelemetryEvent(options.model, {
        type: "tool-execution-finish",
        model: options.model,
        input: context.request,
        step: context.step,
        toolCall: call,
        toolResult: result,
        startedAt,
        finishedAt,
        latencyMs: finishedAt - startedAt
      });
    } catch (error) {
      if (error instanceof ToolExecutionSuspendedError) {
        throw error;
      }
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      let recoveredOutput: unknown;
      if (tool.onError && !(normalizedError instanceof GuardrailTriggeredError)) {
        recoveredOutput = await tool.onError(normalizedError, {
          tool,
          input: item.parsedInput,
          context: item.executionContext
        });
      }
      if (recoveredOutput !== undefined) {
        await runToolGuardrails(item, "output", recoveredOutput);
        const recoveredResult = {
          toolCallId: call.id,
          toolName: call.name,
          output: serializeJsonValue(recoveredOutput),
          isError: false,
          providerMetadata: call.providerMetadata
        } satisfies ToolExecutionResult;
        results[index] = recoveredResult;
        const finishedAt = Date.now();
        await emitLanguageModelTelemetryEvent(options.model, {
          type: "tool-execution-finish",
          model: options.model,
          input: context.request,
          step: context.step,
          toolCall: call,
          toolResult: recoveredResult,
          startedAt,
          finishedAt,
          latencyMs: finishedAt - startedAt
        });
        return;
      }
      if (normalizedError instanceof GuardrailTriggeredError) {
        throw normalizedError;
      }
      const result = {
        toolCallId: call.id,
        toolName: call.name,
        error: { message: normalizedError.message },
        isError: true,
        providerMetadata: call.providerMetadata
      } satisfies ToolExecutionResult;
      results[index] = result;

      const finishedAt = Date.now();
      await emitLanguageModelTelemetryEvent(options.model, {
        type: "tool-execution-error",
        model: options.model,
        input: context.request,
        step: context.step,
        toolCall: call,
        error: normalizedError,
        startedAt,
        finishedAt,
        latencyMs: finishedAt - startedAt
      });
    }
  };

  if (!parallel || validatedCalls.length <= 1) {
    for (const [index, item] of validatedCalls.entries()) {
      try {
        await executeSingleTool(item, index);
      } catch (error) {
        if (error instanceof ToolExecutionSuspendedError) {
          throw new ToolExecutionSuspendedError(
            error.approvals,
            results.filter((result): result is ToolExecutionResult => Boolean(result))
          );
        }
        throw error;
      }
      if (stopOnError && results[index]?.isError) {
        throw new Error(`Tool "${item.call.name}" failed: ${results[index]?.error?.message ?? "Unknown tool error."}`);
      }
    }
    return results;
  }

  let cursor = 0;
  const workers = Array.from({ length: Math.min(maxConcurrency, validatedCalls.length) }, async () => {
    while (cursor < validatedCalls.length) {
      const index = cursor;
      cursor += 1;
      await executeSingleTool(validatedCalls[index], index);
    }
  });
  await Promise.all(workers);

  if (stopOnError) {
    const firstError = results.find((result) => result?.isError);
    if (firstError) {
      throw new Error(`Tool "${firstError.toolName}" failed: ${firstError.error?.message ?? "Unknown tool error."}`);
    }
  }
  return results;
};

export const normalizeMessages = buildMessages;

const extractToolCalls = (messages: ModelMessage[]): ToolCall[] =>
  messages.flatMap((message) =>
    message.parts
      .filter((part): part is Extract<ModelMessage["parts"][number], { type: "tool-call" }> => part.type === "tool-call")
      .map((part) => part.toolCall)
  );

const extractUnresolvedToolCalls = (messages: ModelMessage[]): ToolCall[] => {
  const completed = new Set(
    messages.flatMap((message) =>
      message.parts
        .filter((part) => part.type === "tool-result")
        .map((part) => part.toolResult.toolCallId)
    )
  );
  return extractToolCalls(messages).filter((call) => !completed.has(call.id));
};

const validateToolChoice = (options: {
  model: AnyGenerateTextOptions["model"];
  tools?: ReturnType<typeof toToolSet>;
  toolChoice?: AnyGenerateTextOptions["toolChoice"];
}) => {
  if (!options.toolChoice) {
    return;
  }

  if (!options.model.capabilities.tools) {
    throw new UnsupportedFeatureError(`Model "${options.model.provider}/${options.model.modelId}" does not support tools.`);
  }

  if (!options.model.capabilities.toolChoice) {
    throw new UnsupportedFeatureError(
      `Model "${options.model.provider}/${options.model.modelId}" does not support tool choice.`
    );
  }

  if (!options.tools || Object.keys(options.tools).length === 0) {
    throw new ValidationError('The "toolChoice" option requires at least one registered tool.');
  }

  if (typeof options.toolChoice === "object" && !options.tools[options.toolChoice.toolName]) {
    throw new ValidationError(`The selected tool "${options.toolChoice.toolName}" is not registered.`);
  }
};

export const generateText = async <
  TModel extends LanguageModel,
  TContext = unknown
>(
  options: GenerateTextOptions<TModel, TContext>
): Promise<GenerateTextOutput> => {
  const maxSteps = Math.max(1, options.maxSteps ?? 1);
  const allMessages = buildMessages(options);
  const steps: GenerateTextOutput["steps"] = [];
  const tools = toToolSet(options.tools);
  const resolvedTools = tools ?? {};
  validateMessageParts(options.model, allMessages);
  validateReasoning(options);
  validateToolChoice({
    model: options.model,
    tools,
    toolChoice: options.toolChoice
  });

  if (tools && !options.model.capabilities.tools) {
    throw new UnsupportedFeatureError(`Model "${options.model.provider}/${options.model.modelId}" does not support tools.`);
  }

  const toolResults: ToolExecutionResult[] = [];
  const generatedMessages: ModelMessage[] = [];
  const approvalRequests: NonNullable<GenerateTextOutput["approvalRequests"]> = [];
  let finalResult: GenerateResult | undefined;
  let effectsPossible = false;

  const pendingToolCalls = extractUnresolvedToolCalls(allMessages);
  if (pendingToolCalls.length) {
    const request = toRequest(options, allMessages);
    const step = options.stepOffset ?? 0;
    const preflight = await preflightTools(pendingToolCalls, options, {
      request,
      step,
      tools: resolvedTools
    });
    if (preflight.approvalRequests.length) {
      approvalRequests.push(...preflight.approvalRequests);
      return {
        text: "",
        finishReason: "tool-calls",
        steps,
        messages: allMessages,
        toolResults,
        approvalRequests
      };
    }
    await options.onBeforeToolExecution?.({ request, step, toolCalls: pendingToolCalls });
    let recoveredToolResults: ToolExecutionResult[];
    try {
      effectsPossible = true;
      recoveredToolResults = await executeTools(preflight, options, {
        request,
        step
      });
    } catch (error) {
      if (!(error instanceof ToolExecutionSuspendedError)) {
        throw error;
      }
      toolResults.push(...error.completedResults);
      for (const result of error.completedResults) {
        allMessages.push({ role: "tool", parts: [toolResultPart(result)] });
      }
      if (error.completedResults.length) {
        await options.onToolExecutionComplete?.({
          request,
          step,
          toolResults: error.completedResults
        });
      }
      approvalRequests.push(...error.approvals);
      return {
        text: "",
        finishReason: "tool-calls",
        steps,
        messages: allMessages,
        toolResults,
        approvalRequests
      };
    }
    toolResults.push(...recoveredToolResults);
    for (const result of recoveredToolResults) {
      allMessages.push({ role: "tool", parts: [toolResultPart(result)] });
    }
    await options.onToolExecutionComplete?.({ request, step, toolResults: recoveredToolResults });
  }

  for (let step = 0; step < maxSteps; step += 1) {
    const absoluteStep = (options.stepOffset ?? 0) + step + 1;
    const preparedMessages = await options.prepareModelMessages?.({
      messages: structuredClone(allMessages),
      step: absoluteStep
    });
    if (preparedMessages) {
      allMessages.splice(0, allMessages.length, ...structuredClone(preparedMessages));
    }
    const request = toRequest(options, allMessages);
    await options.onBeforeModelStep?.({ request, step: absoluteStep });
    const startedAt = Date.now();
    let response: GenerateResult;
    try {
      response = await options.model.generate(request);
    } catch (error) {
      throw withPossibleToolEffects(error, effectsPossible);
    }
    stepTimings.set(request, { startedAt, finishedAt: Date.now() });
    steps.push({ request, response });
    finalResult = response;

    const responseMessages = resultMessages(response);
    if (responseMessages.length) {
      allMessages.push(...responseMessages);
      generatedMessages.push(...responseMessages);
    }

    const toolCalls = extractToolCalls(responseMessages);
    const preflight = toolCalls.length
      ? await preflightTools(toolCalls, options, {
          request,
          step: absoluteStep,
          tools: resolvedTools
        })
      : undefined;
    if (preflight?.approvalRequests.length) {
      approvalRequests.push(...preflight.approvalRequests);
    }
    await options.onModelStep?.({
      request,
      response,
      step: absoluteStep,
      toolCalls,
      approvalRequests: preflight?.approvalRequests ?? []
    });
    if (!toolCalls.length || preflight?.approvalRequests.length) {
      break;
    }

    await options.onBeforeToolExecution?.({ request, step: absoluteStep, toolCalls });
    let currentToolResults: ToolExecutionResult[];
    try {
      effectsPossible = true;
      currentToolResults = await executeTools(preflight!, options, {
        request,
        step: absoluteStep
      });
    } catch (error) {
      if (!(error instanceof ToolExecutionSuspendedError)) {
        throw error;
      }
      toolResults.push(...error.completedResults);
      for (const result of error.completedResults) {
        allMessages.push({
          role: "tool",
          parts: [toolResultPart(result)]
        });
      }
      if (error.completedResults.length) {
        await options.onToolExecutionComplete?.({
          request,
          step: absoluteStep,
          toolResults: error.completedResults
        });
      }
      approvalRequests.push(...error.approvals);
      break;
    }
    toolResults.push(...currentToolResults);

    for (const result of currentToolResults) {
      allMessages.push({
        role: "tool",
        parts: [toolResultPart(result)]
      });
    }
    await options.onToolExecutionComplete?.({ request, step: absoluteStep, toolResults: currentToolResults });
  }

  if (!finalResult) {
    throw new ParseError("Model did not return a result.");
  }

  return {
    text: getTextFromMessages(generatedMessages),
    finishReason: finalResult.finishReason,
    providerFinishReason: finalResult.providerFinishReason,
    usage: aggregateTokenUsage(steps.map((step) => step.response.usage)),
    steps,
    messages: allMessages,
    toolResults,
    approvalRequests
  };
};

export const streamText = <
  TModel extends LanguageModel,
  TContext = unknown
>(
  options: GenerateTextOptions<TModel, TContext>
): StreamTextResult => {
  const maxSteps = Math.max(1, options.maxSteps ?? 1);
  const baseMessages = buildMessages(options);
  const tools = toToolSet(options.tools);
  const resolvedTools = tools ?? {};
  validateMessageParts(options.model, baseMessages);
  validateReasoning(options);
  validateToolChoice({
    model: options.model,
    tools,
    toolChoice: options.toolChoice
  });

  if (!options.model.stream) {
    throw new ValidationError(`Model "${options.model.provider}/${options.model.modelId}" does not support streaming.`);
  }
  const streamModel = options.model.stream.bind(options.model);

  if (tools && !options.model.capabilities.tools) {
    throw new UnsupportedFeatureError(`Model "${options.model.provider}/${options.model.modelId}" does not support tools.`);
  }

  const broadcast = new BoundedReplayBroadcast<StreamEvent>();
  let finalResultPromise: Promise<GenerateTextOutput> | undefined;
  let effectsPossible = false;

  const publish = async (event: StreamEvent, terminal = false) => {
    // Progressive binary previews are useful only to live consumers. Retaining
    // them for collect(), textStream, or a late eventStream replay duplicates
    // potentially large buffers without changing the final generated result.
    await broadcast.publish(event, {
      replay: event.type !== "image-generation" || !event.partial,
      terminal
    });
  };

  const createEventStream = (
    accepts: (event: StreamEvent) => boolean = () => true
  ) => broadcast.stream(accepts);

  const runner = async (): Promise<GenerateTextOutput> => {
    const allMessages = [...baseMessages];
    const generatedMessages: ModelMessage[] = [];
    const steps: GenerateTextOutput["steps"] = [];
    const toolResults: ToolExecutionResult[] = [];
    const approvalRequests: NonNullable<GenerateTextOutput["approvalRequests"]> = [];
    let finalResult: GenerateResult | undefined;

    const pendingToolCalls = extractUnresolvedToolCalls(allMessages);
    if (pendingToolCalls.length) {
      const request = toRequest(options, allMessages);
      const step = options.stepOffset ?? 0;
      const preflight = await preflightTools(pendingToolCalls, options, {
        request,
        step,
        tools: resolvedTools
      });
      if (preflight.approvalRequests.length) {
        approvalRequests.push(...preflight.approvalRequests);
        for (const approval of preflight.approvalRequests) {
          await publish({ type: "tool-approval-request", approval });
        }
        await publish({ type: "finish", finishReason: "tool-calls" }, true);
        broadcast.close();
        return {
          text: "",
          finishReason: "tool-calls",
          steps,
          messages: allMessages,
          toolResults,
          approvalRequests
        };
      }
      await options.onBeforeToolExecution?.({ request, step, toolCalls: pendingToolCalls });
      let recoveredToolResults: ToolExecutionResult[];
      try {
        effectsPossible = true;
        recoveredToolResults = await executeTools(preflight, options, {
          request,
          step
        });
      } catch (error) {
        if (!(error instanceof ToolExecutionSuspendedError)) {
          throw error;
        }
        toolResults.push(...error.completedResults);
        for (const result of error.completedResults) {
          await publish({ type: "tool-result", toolResult: result });
          allMessages.push({ role: "tool", parts: [toolResultPart(result)] });
        }
        if (error.completedResults.length) {
          await options.onToolExecutionComplete?.({
            request,
            step,
            toolResults: error.completedResults
          });
        }
        approvalRequests.push(...error.approvals);
        for (const approval of error.approvals) {
          await publish({ type: "tool-approval-request", approval });
        }
        await publish({ type: "finish", finishReason: "tool-calls" }, true);
        broadcast.close();
        return {
          text: "",
          finishReason: "tool-calls",
          steps,
          messages: allMessages,
          toolResults,
          approvalRequests
        };
      }
      toolResults.push(...recoveredToolResults);
      for (const result of recoveredToolResults) {
        await publish({ type: "tool-result", toolResult: result });
        allMessages.push({ role: "tool", parts: [toolResultPart(result)] });
      }
      await options.onToolExecutionComplete?.({ request, step, toolResults: recoveredToolResults });
    }

    for (let step = 0; step < maxSteps; step += 1) {
      const absoluteStep = (options.stepOffset ?? 0) + step + 1;
      const preparedMessages = await options.prepareModelMessages?.({
        messages: structuredClone(allMessages),
        step: absoluteStep
      });
      if (preparedMessages) {
        allMessages.splice(0, allMessages.length, ...structuredClone(preparedMessages));
      }
      const request = toRequest(options, allMessages);
      await options.onBeforeModelStep?.({ request, step: absoluteStep });
      const startedAt = Date.now();
      const stream = await streamModel(request);
      const stepMessages: ModelMessage[] = [];
      let textBuffer = "";
      const generatedImages: NonNullable<GenerateResult["images"]> = [];
      let finishReason = normalizeFinishReason("stop");
      let providerFinishReason: string | undefined;
      let usage = undefined;

      for await (const event of stream) {
        await publish(event);

        if (event.type === "text-delta") {
          textBuffer += event.textDelta;
        }

        if (event.type === "tool-call") {
          const existingAssistant = stepMessages.find((message) => message.role === "assistant");
          if (existingAssistant) {
            existingAssistant.parts.push(toolCallPart(event.toolCall));
          } else {
            stepMessages.push({
              role: "assistant",
              parts: [toolCallPart(event.toolCall)]
            });
          }
        }

        if (event.type === "provider-data") {
          const existingAssistant = stepMessages.find((message) => message.role === "assistant");
          if (existingAssistant) {
            existingAssistant.parts.push(providerDataPart(event.provider, event.data));
          } else {
            stepMessages.push({
              role: "assistant",
              parts: [providerDataPart(event.provider, event.data)]
            });
          }
        }

        if (event.type === "image-generation" && !event.partial) {
          generatedImages.push(event.image);
        }

        if (event.type === "finish") {
          finishReason = event.finishReason;
          providerFinishReason = event.providerFinishReason;
          usage = event.usage;
        }
      }
      stepTimings.set(request, { startedAt, finishedAt: Date.now() });

      if (textBuffer) {
        const assistant = stepMessages.find((message) => message.role === "assistant");
        if (assistant) {
          assistant.parts.unshift({ type: "text", text: textBuffer });
        } else {
          stepMessages.unshift(createTextMessage("assistant", textBuffer));
        }
      }

      finalResult = {
        messages: stepMessages,
        text: textBuffer,
        images: generatedImages.length ? generatedImages : undefined,
        finishReason,
        providerFinishReason,
        usage
      };

      steps.push({ request, response: finalResult });
      allMessages.push(...stepMessages);
      generatedMessages.push(...stepMessages);

      const toolCalls = extractToolCalls(stepMessages);
      const preflight = toolCalls.length
        ? await preflightTools(toolCalls, options, {
            request,
            step: absoluteStep,
            tools: resolvedTools
          })
        : undefined;
      if (preflight?.approvalRequests.length) {
        approvalRequests.push(...preflight.approvalRequests);
        for (const approval of preflight.approvalRequests) {
          await publish({ type: "tool-approval-request", approval });
        }
      }
      await options.onModelStep?.({
        request,
        response: finalResult,
        step: absoluteStep,
        toolCalls,
        approvalRequests: preflight?.approvalRequests ?? []
      });
      if (!toolCalls.length || preflight?.approvalRequests.length) {
        break;
      }

      await options.onBeforeToolExecution?.({ request, step: absoluteStep, toolCalls });
      let currentToolResults: ToolExecutionResult[];
      try {
        effectsPossible = true;
        currentToolResults = await executeTools(preflight!, options, {
          request,
          step: absoluteStep
        });
      } catch (error) {
        if (!(error instanceof ToolExecutionSuspendedError)) {
          throw error;
        }
        toolResults.push(...error.completedResults);
        for (const result of error.completedResults) {
          await publish({ type: "tool-result", toolResult: result });
          allMessages.push({
            role: "tool",
            parts: [toolResultPart(result)]
          });
        }
        if (error.completedResults.length) {
          await options.onToolExecutionComplete?.({
            request,
            step: absoluteStep,
            toolResults: error.completedResults
          });
        }
        approvalRequests.push(...error.approvals);
        for (const approval of error.approvals) {
          await publish({ type: "tool-approval-request", approval });
        }
        break;
      }
      toolResults.push(...currentToolResults);

      for (const toolResult of currentToolResults) {
        await publish({ type: "tool-result", toolResult });
        allMessages.push({
          role: "tool",
          parts: [toolResultPart(toolResult)]
        });
      }
      await options.onToolExecutionComplete?.({ request, step: absoluteStep, toolResults: currentToolResults });
    }

    if (!finalResult) {
      throw new ParseError("Model did not return a result.");
    }

    const usage = aggregateTokenUsage(steps.map((step) => step.response.usage));

    await publish({
      type: "finish",
      finishReason: finalResult.finishReason,
      providerFinishReason: finalResult.providerFinishReason,
      usage
    }, true);
    broadcast.close();

    return {
      text: getTextFromMessages(generatedMessages),
      finishReason: finalResult.finishReason,
      providerFinishReason: finalResult.providerFinishReason,
      usage,
      steps,
      messages: allMessages,
      toolResults,
      approvalRequests
    };
  };

  finalResultPromise = runner().catch(async (error) => {
    const contextualizedError = withPossibleToolEffects(error, effectsPossible);
    if (!(contextualizedError instanceof Error && contextualizedError.name === "StreamBufferOverflowError")) {
      await publish({
        type: "error",
        error: contextualizedError instanceof Error ? contextualizedError : new Error(String(contextualizedError))
      }, true);
      broadcast.close();
    }
    throw contextualizedError;
  });

  return {
    eventStream: createEventStream(),
    textStream: (async function* () {
      for await (const event of createEventStream((candidate) => candidate.type === "text-delta")) {
        if (event.type === "text-delta") {
          yield event.textDelta;
        }
      }
    })(),
    collect: async () => finalResultPromise
  };
};
