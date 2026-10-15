import { createRedactionPolicy, type RedactionPolicy, type RedactionPolicyOptions } from "./safety-policy.js";
import type { GenerateResult, GenerationRedaction, GenerationRedactionOptions, ModelMessage, ToolCall, ToolExecutionResult } from "./types.js";

export interface ActiveGenerationRedaction {
  policy: RedactionPolicy;
  input: boolean;
  toolInputs: boolean;
  toolResults: boolean;
  output: boolean;
}

const isPolicy = (value: object): value is RedactionPolicy =>
  "redactText" in value && "redactMessages" in value && "redactJson" in value &&
  typeof (value as RedactionPolicy).redactText === "function";

const isPolicyOptions = (value: object): value is RedactionPolicyOptions =>
  "rules" in value || "includeEmails" in value || "replacement" in value;

const isWrapped = (value: object): value is GenerationRedactionOptions & { policy?: GenerationRedactionOptions["policy"] } =>
  "policy" in value || "input" in value || "toolInputs" in value || "toolResults" in value || "output" in value;

const asPolicy = (value: GenerationRedactionOptions["policy"]): RedactionPolicy => {
  if (value && typeof value === "object" && isPolicy(value)) {
    return value;
  }
  return createRedactionPolicy((value ?? {}) as RedactionPolicyOptions);
};

/** `false` and omission leave generation unchanged. */
export const resolveGenerationRedaction = (
  value: GenerationRedaction | undefined
): ActiveGenerationRedaction | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if (isPolicy(value)) {
    return { policy: value, input: true, toolInputs: true, toolResults: true, output: true };
  }
  if (isWrapped(value) && ("policy" in value || "input" in value || "toolInputs" in value || "toolResults" in value || "output" in value)) {
    const wrapped = value as GenerationRedactionOptions;
    return {
      policy: asPolicy(wrapped.policy),
      input: wrapped.input ?? true,
      toolInputs: wrapped.toolInputs ?? true,
      toolResults: wrapped.toolResults ?? true,
      output: wrapped.output ?? true
    };
  }
  if (isPolicyOptions(value)) {
    return {
      policy: createRedactionPolicy(value),
      input: true,
      toolInputs: true,
      toolResults: true,
      output: true
    };
  }
  return undefined;
};

export const redactToolExecutionResult = (
  result: ToolExecutionResult,
  policy: RedactionPolicy
): ToolExecutionResult => ({
  ...result,
  output: result.output === undefined ? undefined : policy.redactJson(result.output),
  error: result.error ? { ...result.error, message: policy.redactText(result.error.message) } : undefined
});

export const redactToolCall = (call: ToolCall, policy: RedactionPolicy): ToolCall => ({
  ...call,
  input: policy.redactJson(call.input),
  providerMetadata: call.providerMetadata
    ? policy.redactJson(call.providerMetadata) as ToolCall["providerMetadata"]
    : undefined
});

export const redactModelMessages = (
  messages: ModelMessage[],
  active: ActiveGenerationRedaction
): ModelMessage[] => messages.map((message) => ({
  ...message,
  parts: message.parts.map((part) => {
    if (part.type === "text") {
      const enabled = message.role === "assistant" ? active.output : active.input;
      return enabled ? { ...part, text: active.policy.redactText(part.text) } : part;
    }
    if (part.type === "tool-call" && active.toolInputs) {
      return { ...part, toolCall: redactToolCall(part.toolCall, active.policy) };
    }
    if (part.type === "tool-result" && active.toolResults) {
      return { ...part, toolResult: redactToolExecutionResult(part.toolResult, active.policy) };
    }
    return part;
  })
}));

/**
 * Holds back the tail of a stream so a check-digit match split across deltas
 * is replaced before it is emitted. The flushed concatenation equals
 * `redactText` of the full raw text when the holdback covers the longest match.
 */
export const createHeldTextRedactor = (redactText: (text: string) => string, holdback = 48) => {
  let raw = "";
  let emitted = "";

  const take = (flush: boolean) => {
    const redacted = redactText(raw);
    const limit = flush || raw.length <= holdback
      ? (flush ? redacted.length : 0)
      : (() => {
          const stable = redactText(raw.slice(0, raw.length - holdback));
          let shared = 0;
          const max = Math.min(stable.length, redacted.length);
          while (shared < max && stable[shared] === redacted[shared]) shared += 1;
          return shared;
        })();
    const next = redacted.slice(0, limit);
    if (!next.startsWith(emitted)) {
      return "";
    }
    const delta = next.slice(emitted.length);
    emitted = next;
    return delta;
  };

  return {
    push(delta: string) {
      raw += delta;
      return take(false);
    },
    flush() {
      return take(true);
    },
    value() {
      return redactText(raw);
    }
  };
};

export const sealModelMessages = (
  messages: ModelMessage[],
  active: ActiveGenerationRedaction | undefined
): ModelMessage[] => active ? redactModelMessages(messages, active) : messages;

export const sealToolResults = (
  results: ToolExecutionResult[],
  active: ActiveGenerationRedaction | undefined
): ToolExecutionResult[] =>
  active?.toolResults ? results.map((result) => redactToolExecutionResult(result, active.policy)) : results;

export const sealGenerateResult = (
  response: GenerateResult,
  active: ActiveGenerationRedaction | undefined
): GenerateResult => {
  if (!active) return response;
  return {
    ...response,
    text: active.output && response.text ? active.policy.redactText(response.text) : response.text,
    message: response.message ? redactModelMessages([response.message], active)[0] : response.message,
    messages: response.messages ? redactModelMessages(response.messages, active) : response.messages
  };
};
