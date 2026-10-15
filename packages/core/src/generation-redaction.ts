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

/** `false` and omission leave generation unchanged. Any other object, including `{}`, redacts with the default policy. */
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
  return {
    policy: createRedactionPolicy({}),
    input: true,
    toolInputs: true,
    toolResults: true,
    output: true
  };
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

type MatchSpan = number | "unbounded";

const addSpan = (left: MatchSpan, right: MatchSpan): MatchSpan =>
  left === "unbounded" || right === "unbounded" ? "unbounded" : left + right;

/**
 * Maximum characters a pattern can consume or look ahead of. Unbounded
 * quantifiers and anything the scanner cannot prove bounded stay withheld.
 */
const maximumPatternSpan = (source: string): MatchSpan => {
  let index = 0;

  const skipLazy = () => {
    if (source[index] === "?") index += 1;
  };

  const readClass = (): MatchSpan => {
    index += 1;
    if (source[index] === "^") index += 1;
    if (source[index] === "]") index += 1;
    while (index < source.length && source[index] !== "]") {
      index += source[index] === "\\" ? 2 : 1;
    }
    if (source[index] !== "]") return "unbounded";
    index += 1;
    return 1;
  };

  const readEscape = (): MatchSpan => {
    index += 1;
    const code = source[index];
    if (code === undefined) return "unbounded";
    index += 1;
    if (code === "b" || code === "B") return 0;
    if (code >= "1" && code <= "9") return "unbounded";
    if (code === "k") {
      if (source[index] === "<") {
        const end = source.indexOf(">", index);
        if (end < 0) return "unbounded";
        index = end + 1;
      }
      return "unbounded";
    }
    if ((code === "u" || code === "p" || code === "P") && source[index] === "{") {
      const end = source.indexOf("}", index);
      if (end < 0) return "unbounded";
      index = end + 1;
      return 1;
    }
    if (code === "u") index += 4;
    else if (code === "x") index += 2;
    else if (code === "c") index += 1;
    return 1;
  };

  const readSequence = (closing: boolean): MatchSpan => {
    let best: MatchSpan = 0;
    let branch: MatchSpan = 0;
    const fold = () => {
      best = addSpan(best, 0) === "unbounded" || branch === "unbounded" ? "unbounded" : Math.max(best as number, branch as number);
      branch = 0;
    };
    while (index < source.length) {
      if (closing && source[index] === ")") break;
      if (source[index] === "|") {
        index += 1;
        fold();
        continue;
      }
      const atom = readQuantified();
      if (atom === "unbounded") return "unbounded";
      branch = addSpan(branch, atom);
    }
    fold();
    return best;
  };

  const readGroup = (): MatchSpan => {
    index += 1;
    if (source[index] !== "?") {
      const span = readSequence(true);
      if (source[index] !== ")") return "unbounded";
      index += 1;
      return span;
    }
    index += 1;
    const marker = source[index];
    if (marker === ":") {
      index += 1;
      const span = readSequence(true);
      if (source[index] !== ")") return "unbounded";
      index += 1;
      return span;
    }
    if (marker === "=" || marker === "!") {
      index += 1;
      const span = readSequence(true);
      if (source[index] !== ")") return "unbounded";
      index += 1;
      return span;
    }
    if (marker === "<") {
      index += 1;
      const next = source[index];
      if (next === "=" || next === "!") {
        index += 1;
        if (readSequence(true) === "unbounded") return "unbounded";
        if (source[index] !== ")") return "unbounded";
        index += 1;
        return 0;
      }
      const end = source.indexOf(">", index);
      if (end < 0) return "unbounded";
      index = end + 1;
      const span = readSequence(true);
      if (source[index] !== ")") return "unbounded";
      index += 1;
      return span;
    }
    if (marker === "#") {
      const end = source.indexOf(")", index);
      if (end < 0) return "unbounded";
      index = end + 1;
      return 0;
    }
    return "unbounded";
  };

  const readAtom = (): MatchSpan => {
    if (index >= source.length) return "unbounded";
    const char = source[index]!;
    if (char === "*" || char === "+" || char === "?" || char === "{") return "unbounded";
    if (char === "\\") return readEscape();
    if (char === "[") return readClass();
    if (char === "(") return readGroup();
    if (char === ".") {
      index += 1;
      return 1;
    }
    if (char === "^" || char === "$") {
      index += 1;
      return 0;
    }
    index += 1;
    return 1;
  };

  const readQuantified = (): MatchSpan => {
    const atom = readAtom();
    if (atom === "unbounded" || index >= source.length) return atom;
    const quant = source[index];
    if (quant !== "*" && quant !== "+" && quant !== "?" && quant !== "{") return atom;
    if (quant === "?") {
      index += 1;
      skipLazy();
      return atom;
    }
    if (quant === "*" || quant === "+") {
      index += 1;
      skipLazy();
      return atom === 0 ? 0 : "unbounded";
    }
    const saved = index;
    index += 1;
    const match = /^(\d+)(,(\d+)?)?/.exec(source.slice(index));
    if (!match || source[index + match[0].length] !== "}") {
      index = saved;
      return atom;
    }
    index += match[0].length + 1;
    skipLazy();
    const max = match[2] === undefined
      ? Number(match[1])
      : match[3] === undefined ? "unbounded" : Number(match[3]);
    if (max === "unbounded") return atom === 0 ? 0 : "unbounded";
    return atom * max;
  };

  const span = readSequence(false);
  return index === source.length ? span : "unbounded";
};

/** Characters that must stay buffered so a later match cannot reveal an already emitted prefix. */
export const holdbackForPolicy = (policy: { rules?: readonly { pattern: RegExp | string }[] }): MatchSpan => {
  if (!policy.rules || policy.rules.length === 0) return "unbounded";
  let holdback = 0;
  for (const rule of policy.rules) {
    const source = typeof rule.pattern === "string" ? rule.pattern : rule.pattern.source;
    const span = maximumPatternSpan(source);
    if (span === "unbounded") return "unbounded";
    holdback = Math.max(holdback, span);
  }
  return holdback;
};

/**
 * Holds back the tail of a stream so a match split across deltas is replaced
 * before it is emitted. Bounded patterns keep their maximum match length.
 * An unbounded pattern emits nothing until flush.
 */
export const createHeldTextRedactor = (
  redactText: (text: string) => string,
  holdback: MatchSpan = 48
) => {
  let raw = "";
  let emitted = "";

  const sharedPrefix = (stable: string, redacted: string) => {
    let shared = 0;
    const max = Math.min(stable.length, redacted.length);
    while (shared < max && stable[shared] === redacted[shared]) shared += 1;
    return shared;
  };

  const take = (flush: boolean) => {
    const redacted = redactText(raw);
    const buffered = holdback === "unbounded" || raw.length <= holdback;
    const limit = flush
      ? redacted.length
      : buffered
        ? 0
        : sharedPrefix(redactText(raw.slice(0, raw.length - holdback)), redacted);
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
