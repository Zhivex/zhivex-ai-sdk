import { randomUUID } from "node:crypto";

import {
  ConfigurationError,
  ParseError,
  UnsupportedFeatureError,
  ValidationError,
  createProviderAdapter,
  serializeJsonValue,
  withRetry,
  withTimeoutSignal,
  type GenerateResult,
  type LanguageModel,
  type ModelCapabilities,
  type ModelGenerateInput,
  type ModelMessage,
  type StreamEvent,
  type TokenUsage
} from "@zhivex-ai/core/provider";

import { buildGenerateParams, resolveUseCase } from "./conversation.js";
import { AppleLocalError } from "./errors.js";
import type { AppleLocalLanguageModelOptions } from "./options.js";
import {
  APPLE_LOCAL_PROTOCOL_VERSION,
  APPLE_LOCAL_UNAVAILABLE_REASONS,
  APPLE_LOCAL_USE_CASES,
  type AppleLocalAvailability,
  type AppleLocalBridgeError,
  type AppleLocalErrorCode,
  type AppleLocalEvent,
  type AppleLocalRequest,
  type AppleLocalResult,
  type AppleLocalServerMessage,
  type AppleLocalStatusParams,
  type AppleLocalTransport,
  type AppleLocalUsage,
  type AppleLocalUseCase
} from "./protocol.js";
import { createAppleLocalInvokeTransport, createAppleLocalStdioTransport } from "./transport.js";

export {
  APPLE_LOCAL_PROTOCOL_VERSION,
  AppleLocalError,
  createAppleLocalInvokeTransport,
  createAppleLocalStdioTransport
};
export type {
  AppleLocalAvailability,
  AppleLocalBridgeError,
  AppleLocalErrorCode,
  AppleLocalEvent,
  AppleLocalGenerateParams,
  AppleLocalRequest,
  AppleLocalResult,
  AppleLocalServerMessage,
  AppleLocalTransport,
  AppleLocalUseCase
} from "./protocol.js";
export type { AppleLocalLanguageModelOptions } from "./options.js";
export type { AppleLocalInvokeTransportOptions, AppleLocalStdioTransportOptions } from "./transport.js";

const capabilities: ModelCapabilities = {
  streaming: true,
  tools: true,
  structuredOutput: true,
  jsonMode: false,
  toolChoice: true,
  parallelToolCalls: true,
  vision: true,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
  reasoning: false,
  webSearch: false,
  sampling: { topP: true, seed: true, stopSequences: false },
  toolHistory: "native",
  agentCapabilities: {
    supportTier: "tier-c",
    toolChoiceNone: true,
    approvalRequests: false,
    hostedWebSearch: false,
    hostedFileSearch: false,
    remoteMcp: false,
    computerUse: false,
    codeExecution: false,
    toolsets: false
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const unavailableMessage = (reason: AppleLocalAvailability["reason"]): string => {
  switch (reason) {
    case "deviceNotEligible":
      return "Apple Intelligence is not available on this device. SystemLanguageModel.Availability reports deviceNotEligible.";
    case "appleIntelligenceNotEnabled":
      return "Apple Intelligence is turned off. Enable it before calling the on-device model.";
    case "modelNotReady":
      return "The on-device model is not ready. It may still be downloading or the system is still preparing Apple Intelligence.";
    default:
      return "The on-device Apple Intelligence model is unavailable.";
  }
};

const bridgeFailure = (error: AppleLocalBridgeError): AppleLocalError =>
  new AppleLocalError(error.message, error.code, error.retryAt ? { retryAt: error.retryAt } : undefined);

const optionalCount = (value: unknown, label: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ParseError(`Apple Local usage.${label} must be a non-negative finite number.`);
  }
  return value;
};

const parseUsage = (value: unknown): TokenUsage | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new ParseError("Apple Local usage must be an object.");
  const usage: AppleLocalUsage = {
    inputTokens: optionalCount(value.inputTokens, "inputTokens"),
    cachedInputTokens: optionalCount(value.cachedInputTokens, "cachedInputTokens"),
    outputTokens: optionalCount(value.outputTokens, "outputTokens"),
    reasoningTokens: optionalCount(value.reasoningTokens, "reasoningTokens"),
    totalTokens: optionalCount(value.totalTokens, "totalTokens")
  };
  return {
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
    ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {})
  };
};

const parseToolCall = (value: unknown, path: string) => {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" || !isRecord(value.arguments)) {
    throw new ParseError(`${path} must include string id, string name, and object arguments.`);
  }
  return { id: value.id, name: value.name, arguments: value.arguments };
};

const parseAvailability = (value: unknown): AppleLocalAvailability => {
  if (!isRecord(value) || typeof value.available !== "boolean" || typeof value.imageInput !== "boolean") {
    throw new ParseError("Apple Local status requires available and imageInput booleans.");
  }
  if (!APPLE_LOCAL_USE_CASES.includes(value.useCase as AppleLocalUseCase)) {
    throw new ParseError("Apple Local status useCase must be general or contentTagging.");
  }
  if (value.reason !== undefined && !APPLE_LOCAL_UNAVAILABLE_REASONS.includes(value.reason as never)) {
    throw new ParseError(`Apple Local status reason "${String(value.reason)}" is not a documented unavailable reason.`);
  }
  if (value.available && value.reason !== undefined) {
    throw new ParseError("Apple Local status cannot be available and also include an unavailable reason.");
  }
  if (!value.available && value.reason === undefined) {
    throw new ParseError("Apple Local status must include a reason when the model is unavailable.");
  }
  if (value.contextSize !== undefined) {
    const contextSize = value.contextSize;
    if (typeof contextSize !== "number" || !Number.isSafeInteger(contextSize) || contextSize <= 0) {
      throw new ParseError("Apple Local contextSize must be a positive integer when present.");
    }
  }
  if (value.supportedLanguages !== undefined && (!Array.isArray(value.supportedLanguages) || value.supportedLanguages.some((item) => typeof item !== "string"))) {
    throw new ParseError("Apple Local supportedLanguages must be an array of strings.");
  }
  return value as unknown as AppleLocalAvailability;
};

const parseResult = (value: unknown): AppleLocalResult => {
  if (!isRecord(value)) throw new ParseError("Apple Local generation result must be an object.");
  if (value.finishReason !== "stop" && value.finishReason !== "length" && value.finishReason !== "tool-calls") {
    throw new ParseError("Apple Local finishReason must be stop, length, or tool-calls.");
  }
  const toolCalls = value.toolCalls === undefined
    ? undefined
    : Array.isArray(value.toolCalls)
      ? value.toolCalls.map((call, index) => parseToolCall(call, `toolCalls[${index}]`))
      : (() => {
          throw new ParseError("Apple Local toolCalls must be an array.");
        })();
  if (value.finishReason === "tool-calls" && (!toolCalls || toolCalls.length === 0)) {
    throw new ParseError("Apple Local tool-calls results must include at least one tool call.");
  }
  if (value.text !== undefined && typeof value.text !== "string") {
    throw new ParseError("Apple Local result text must be a string.");
  }
  return {
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    finishReason: value.finishReason,
    ...(toolCalls ? { toolCalls } : {}),
    ...(value.usage !== undefined ? { usage: parseUsage(value.usage) } : {})
  };
};

const parseEvent = (value: AppleLocalEvent): AppleLocalEvent => {
  if (value.type === "text-delta" && typeof value.textDelta === "string") return value;
  if (value.type === "tool-call") return { type: "tool-call", toolCall: parseToolCall(value.toolCall, "event.toolCall") };
  throw new ParseError("Apple Local stream event must be a text-delta or a tool-call.");
};

const resultMessage = (result: AppleLocalResult): ModelMessage => ({
  role: "assistant",
  parts: [
    ...(result.text ? [{ type: "text" as const, text: result.text }] : []),
    ...(result.toolCalls ?? []).map((toolCall) => ({
      type: "tool-call" as const,
      toolCall: { id: toolCall.id, name: toolCall.name, input: serializeJsonValue(toolCall.arguments) }
    }))
  ]
});

const toGenerateResult = (result: AppleLocalResult): GenerateResult => ({
  text: result.text ?? "",
  finishReason: result.finishReason,
  message: resultMessage(result),
  ...(result.usage ? { usage: result.usage } : {}),
  providerRequestCount: 1
});

export interface AppleLocalAvailabilityOptions {
  useCase?: AppleLocalUseCase;
  locale?: string;
  signal?: AbortSignal;
}

export interface AppleLocalProviderOptions {
  /** Injected bridge. Use the stdio or invoke helpers, or a test double. */
  transport: AppleLocalTransport;
}

class AppleLocalLanguageModel implements LanguageModel<AppleLocalLanguageModelOptions> {
  readonly provider = "apple-local";
  readonly capabilities = capabilities;

  constructor(
    readonly modelId: string,
    private readonly useCase: AppleLocalUseCase,
    private readonly transport: AppleLocalTransport
  ) {}

  async generate(input: ModelGenerateInput<AppleLocalLanguageModelOptions>): Promise<GenerateResult> {
    const timeout = withTimeoutSignal(input);
    try {
      return await withRetry(async () => {
        const params = buildGenerateParams(this.modelId, this.useCase, input);
        await this.assertReady(params, timeout.signal);
        const result = parseResult(await this.collect(this.request("generate", params), timeout.signal));
        return toGenerateResult(result);
      }, input);
    } finally {
      timeout.cleanup();
    }
  }

  async stream(input: ModelGenerateInput<AppleLocalLanguageModelOptions>): Promise<AsyncIterable<StreamEvent>> {
    const timeout = withTimeoutSignal(input);
    try {
      const params = buildGenerateParams(this.modelId, this.useCase, input);
      await this.assertReady(params, timeout.signal);
      return this.openStream(params, timeout.signal, () => timeout.cleanup());
    } catch (error) {
      timeout.cleanup();
      throw error;
    }
  }

  private openStream(
    params: ReturnType<typeof buildGenerateParams>,
    signal: AbortSignal,
    cleanup: () => void
  ): AsyncIterable<StreamEvent> {
    const transport = this.transport;
    const request = this.request("stream", params);
    return (async function* () {
      try {
        let streamedText = false;
        let streamedTools = false;
        let terminal: AppleLocalResult | undefined;
        for await (const message of transport.send(request, { signal })) {
          if ("error" in message) throw bridgeFailure(message.error);
          if ("event" in message) {
            const event = parseEvent(message.event);
            if (event.type === "text-delta") streamedText = true;
            if (event.type === "tool-call") streamedTools = true;
            yield event.type === "text-delta"
              ? { type: "text-delta", textDelta: event.textDelta }
              : { type: "tool-call", toolCall: { id: event.toolCall.id, name: event.toolCall.name, input: serializeJsonValue(event.toolCall.arguments) } };
            continue;
          }
          terminal = parseResult(message.result);
        }
        if (!terminal) throw new AppleLocalError("Apple Local stream ended without a result.", "protocol");
        if (!streamedText && terminal.text) yield { type: "text-delta", textDelta: terminal.text };
        if (!streamedTools) {
          for (const toolCall of terminal.toolCalls ?? []) {
            yield { type: "tool-call", toolCall: { id: toolCall.id, name: toolCall.name, input: serializeJsonValue(toolCall.arguments) } };
          }
        }
        yield {
          type: "finish",
          finishReason: terminal.finishReason,
          usage: terminal.usage,
          providerRequestCount: 1
        };
      } finally {
        cleanup();
      }
    })();
  }

  private request(method: "generate" | "stream", params: AppleLocalRequest["params"]): AppleLocalRequest {
    return { protocol: APPLE_LOCAL_PROTOCOL_VERSION, id: randomUUID(), method, params };
  }

  private async assertReady(params: { locale?: string; prompt: { images?: readonly unknown[] } }, signal: AbortSignal) {
    const status = await requestAvailability(this.transport, { useCase: this.useCase, locale: params.locale }, signal);
    if ((params.prompt.images?.length ?? 0) > 0 && !status.imageInput) {
      throw new UnsupportedFeatureError(
        "This Apple Intelligence bridge did not report image input. On-device image attachments are documented for the OS 27 system language model. Refusing to send image bytes."
      );
    }
  }

  private async collect(request: AppleLocalRequest, signal: AbortSignal): Promise<unknown> {
    let terminal: unknown;
    for await (const message of this.transport.send(request, { signal })) {
      if (message.id !== request.id) {
        throw new AppleLocalError(`Apple Local bridge responded to "${message.id}" while "${request.id}" was in flight.`, "protocol");
      }
      if ("error" in message) throw bridgeFailure(message.error);
      if ("result" in message) terminal = message.result;
    }
    if (terminal === undefined) throw new AppleLocalError("Apple Local bridge ended without a result.", "protocol");
    return terminal;
  }
}

const requestAvailability = async (
  transport: AppleLocalTransport,
  params: AppleLocalStatusParams,
  signal?: AbortSignal
): Promise<AppleLocalAvailability> => {
  const request: AppleLocalRequest = {
    protocol: APPLE_LOCAL_PROTOCOL_VERSION,
    id: randomUUID(),
    method: "status",
    params
  };
  let terminal: unknown;
  for await (const message of transport.send(request, { signal })) {
    if ("error" in message) throw bridgeFailure(message.error);
    if ("result" in message) terminal = message.result;
  }
  const status = parseAvailability(terminal);
  if (!status.available) {
    const code = (status.reason ?? "unknown") as AppleLocalErrorCode;
    throw new AppleLocalError(unavailableMessage(status.reason), code);
  }
  if (params.locale && status.localeSupported === false) {
    throw new AppleLocalError(
      `The on-device model does not support locale "${params.locale}". supportsLocale returned false.`,
      "unsupportedLanguageOrLocale"
    );
  }
  return status;
};

interface AppleLocalAdapterShape {
  name: "apple-local";
  languageModel(modelId: string): AppleLocalLanguageModel;
  availability(options?: AppleLocalAvailabilityOptions): Promise<AppleLocalAvailability>;
}

export const createAppleLocal = (options: AppleLocalProviderOptions) => {
  if (!options || typeof options.transport?.send !== "function") {
    throw new ConfigurationError(
      "createAppleLocal requires a transport. Inject createAppleLocalStdioTransport, createAppleLocalInvokeTransport, or a test double. There is no API key."
    );
  }
  const transport = options.transport;
  const adapter: AppleLocalAdapterShape = {
    name: "apple-local",
    languageModel(modelId: string) {
      if (typeof modelId !== "string" || modelId.trim() === "") {
        throw new ValidationError("Apple Local model id must be a non-empty string.");
      }
      return new AppleLocalLanguageModel(modelId, resolveUseCase(modelId), transport);
    },
    availability(availabilityOptions = {}) {
      const useCase = availabilityOptions.useCase ?? "general";
      if (!APPLE_LOCAL_USE_CASES.includes(useCase)) {
        throw new ValidationError('Apple Local useCase must be "general" or "contentTagging".');
      }
      return requestAvailability(
        transport,
        { useCase, ...(availabilityOptions.locale ? { locale: availabilityOptions.locale } : {}) },
        availabilityOptions.signal
      );
    }
  };
  return createProviderAdapter(adapter);
};
