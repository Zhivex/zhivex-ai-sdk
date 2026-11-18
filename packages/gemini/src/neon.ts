import { ConfigurationError, ProviderHTTPError, streamSSE } from "@zhivex-ai/core/provider";
import type { Interaction, InteractionCreateInput, ModelMessage, StreamEvent, TokenUsage } from "@zhivex-ai/core/contracts";

export const GEMINI_4_NEON = "gemini-4-neon";
export const neonThinkingLevels = ["low", "medium", "high", "xhigh"] as const;
export const neonLocations = ["global", "us", "eu"] as const;
export const NEON_SEGMENT_TOKENS = 65_536;
const NEON_CONTEXT_TOKENS = 1_048_576;

export const validateNeonOutputLimit = (maxTokens: unknown) => {
  if (maxTokens !== undefined && (
    typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens <= 0 || maxTokens > NEON_CONTEXT_TOKENS
  )) {
    throw new ConfigurationError("Gemini 4 Neon max output tokens must be an integer between 1 and 1,048,576.");
  }
};

/** Map provider-specific content while keeping each group of tool responses in one user turn. */
export const mapNeonMessages = <T>(
  messages: ModelMessage[],
  mapPart: (part: ModelMessage["parts"][number]) => T
) => {
  const contents: Array<{ role: "model" | "user"; parts: Array<T | Record<string, unknown>> }> = [];
  let previousRole: ModelMessage["role"] | undefined;
  for (const { role, parts } of messages) {
    if (role === "system") continue;
    const mapped = parts.flatMap<T | Record<string, unknown>>((part) => {
      if (part.type === "provider-data") return [];
      if (part.type === "text" && role === "assistant" && typeof part.providerMetadata?.geminiThoughtSignature === "string") {
        return [{ text: part.text, thoughtSignature: part.providerMetadata.geminiThoughtSignature }];
      }
      if (part.type === "file" && part.data.startsWith("data:")) {
        const match = /^data:[^,]*;base64,(.*)$/s.exec(part.data);
        if (!match) throw new ConfigurationError("Gemini 4 Neon inline files require base64 data URLs.");
        return [{ inlineData: { mimeType: part.mediaType, data: match[1] } }];
      }
      return [mapPart(part)];
    });
    if (!mapped.length) continue;
    if (role === "tool" && previousRole === "tool") {
      contents.at(-1)!.parts.push(...mapped);
    } else {
      contents.push({ role: role === "assistant" ? "model" : "user", parts: mapped });
    }
    previousRole = role;
  }
  return contents;
};

const invalidContinuation = (message: string) => new ProviderHTTPError(`Gemini 4 Neon ${message}`, 502);

const readToken = (value: unknown) => typeof value === "string" && value.length ? value : undefined;

const continuationTokens = () => {
  const seen = new Set<string>();
  return (value: unknown) => {
    const token = readToken(value);
    if (!token || seen.has(token)) {
      throw invalidContinuation("returned a missing or repeated continuation token.");
    }
    if (seen.size >= NEON_CONTEXT_TOKENS / NEON_SEGMENT_TOKENS - 1) {
      throw invalidContinuation("returned more segments than fit in the model context window.");
    }
    seen.add(token);
    return token;
  };
};

const addUsage = (total: TokenUsage | undefined, segment: TokenUsage | undefined): TokenUsage | undefined => {
  if (!segment) return total;
  total ??= {};
  for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens"] as const) {
    if (segment[key] !== undefined) total[key] = (total[key] ?? 0) + segment[key];
  }
  return total;
};

const wireUsageFields = {
  promptTokenCount: "prompt_token_count",
  cachedContentTokenCount: "cached_content_token_count",
  candidatesTokenCount: "candidates_token_count",
  thoughtsTokenCount: "thoughts_token_count",
  totalTokenCount: "total_token_count"
} as const;

type WireUsage = Record<string, unknown>;

const accumulateContentUsage = (total: WireUsage, usage: WireUsage | undefined, first: boolean) => {
  if (!usage) return;
  for (const [key, alias] of Object.entries(wireUsageFields)) {
    const value = usage[key] ?? usage[alias];
    if (typeof value === "number") total[key] = Number(total[key] ?? 0) + value;
  }
  if (first) {
    const initial = usage.initialPromptTokenCount ?? usage.initial_prompt_token_count ??
      usage.promptTokenCount ?? usage.prompt_token_count;
    if (typeof initial === "number") total.initialPromptTokenCount = initial;
  }
};

const firstCandidate = (json: any) => Array.isArray(json?.candidates)
  ? json.candidates.find((value: any) => value?.index === 0) ??
    json.candidates.find((value: any) => value && value.index === undefined)
  : undefined;

const finishReason = (candidate: any) => candidate?.finishReason ?? candidate?.finish_reason;
const contentToken = (candidate: any) => candidate?.continuationToken ?? candidate?.continuation_token;
const contentUsage = (json: any) => json.usageMetadata ?? json.usage_metadata;

export const generateNeonContent = async (send: (continuationToken?: string) => Promise<any>, signal: AbortSignal) => {
  const nextToken = continuationTokens();
  const segments: any[] = [];
  const parts: unknown[] = [];
  const usage: WireUsage = {};
  let token: string | undefined;

  while (true) {
    signal.throwIfAborted();
    const json = await send(token);
    const candidate = firstCandidate(json);
    if (!segments.length && finishReason(candidate) !== "CONTINUATION") return { json, segments: [json] };

    const nextParts = candidate?.content?.parts;
    if (Array.isArray(nextParts)) for (const part of nextParts) parts.push(part);
    accumulateContentUsage(usage, contentUsage(json), !segments.length);
    segments.push(json);
    if (finishReason(candidate) !== "CONTINUATION") {
      if (!candidate && !json.promptFeedback?.blockReason) {
        throw invalidContinuation("returned a continuation segment without a candidate.");
      }
      return {
        json: {
          ...json,
          ...(candidate ? {
            candidates: [{ ...candidate, finishReason: finishReason(candidate), content: { ...candidate.content, parts } }]
          } : {}),
          usageMetadata: usage
        },
        segments
      };
    }
    token = nextToken(contentToken(candidate));
  }
};

/** Flatten native SSE segments while retaining a single terminal candidate and cumulative billing metadata. */
export async function* streamNeonContent(
  first: Response,
  send: (continuationToken: string) => Promise<Response>,
  signal: AbortSignal
): AsyncGenerator<any> {
  let response = first;
  const nextToken = continuationTokens();
  const usage: WireUsage = {};
  let segmentCount = 1;

  while (true) {
    let terminal: any;
    let segmentUsage: WireUsage | undefined;
    let checkpoint: unknown;
    let promptFeedback: any;
    let groundingMetadata: unknown;
    let responseId: unknown;
    try {
      for await (const event of streamSSE(response)) {
        signal.throwIfAborted();
        if (event.data === "[DONE]") break;
        let json: any;
        try {
          json = JSON.parse(event.data);
        } catch {
          throw invalidContinuation("returned invalid streaming JSON.");
        }
        if (!json || typeof json !== "object" || Array.isArray(json) || json.error ||
            (json.candidates !== undefined && !Array.isArray(json.candidates))) {
          throw invalidContinuation("returned an invalid streaming response.");
        }
        segmentUsage = contentUsage(json) ?? segmentUsage;
        promptFeedback = json.promptFeedback ?? promptFeedback;
        const candidate = firstCandidate(json);
        groundingMetadata = candidate?.groundingMetadata ?? groundingMetadata;
        responseId = json.responseId ?? responseId;
        const reason = finishReason(candidate);
        if (terminal && ((reason !== undefined && reason !== terminal.finishReason) || candidate?.content?.parts?.length)) {
          throw invalidContinuation("returned inconsistent streaming segment metadata.");
        }
        const token = readToken(contentToken(candidate));
        const newCheckpoint = token && token !== checkpoint;
        checkpoint = token ?? checkpoint;
        if (reason !== undefined) {
          if (typeof reason !== "string" || !reason) throw invalidContinuation("returned an invalid finish reason.");
          terminal = { index: candidate.index, finishReason: reason };
          const { finishReason: _finish, finish_reason: _legacyFinish, ...partial } = candidate;
          json = { ...json, candidates: [partial] };
        }
        yield json;
        signal.throwIfAborted();
        if (newCheckpoint) yield { neonContinuationToken: token };
      }
    } finally {
      await response.body?.cancel().catch(() => {});
    }
    signal.throwIfAborted();
    const reason = terminal?.finishReason;
    if (!reason && !promptFeedback?.blockReason) {
      throw invalidContinuation("stream ended without a terminal response.");
    }
    accumulateContentUsage(usage, segmentUsage, segmentCount === 1);
    const completion = {
      ...(terminal ? { candidates: [{
        ...terminal, groundingMetadata,
        ...(checkpoint ? { continuationToken: checkpoint } : {})
      }] } : {}),
      responseId,
      promptFeedback
    };
    if (reason !== "CONTINUATION" || promptFeedback?.blockReason) {
      yield { ...completion, usageMetadata: usage, segmentCount };
      return;
    }
    const token = nextToken(checkpoint);
    yield { neonSegmentEnd: completion };
    signal.throwIfAborted();
    segmentCount += 1;
    response = await send(token);
  }
}

export const shouldContinueNeonInteraction = (input: InteractionCreateInput) =>
  input.modelId === GEMINI_4_NEON && !input.background && input.automaticContinuation !== false;

export const assertNeonInteraction = (input: InteractionCreateInput) => {
  if (input.modelId !== GEMINI_4_NEON) return;
  const config = input.generationConfig;
  if (config && typeof config === "object" && !Array.isArray(config)) {
    validateNeonOutputLimit(config.max_output_tokens ?? config.maxOutputTokens);
  }
  const token = input.continuationToken ?? input.providerOptions?.continuation_token;
  if (input.background && input.store === false) {
    throw new ConfigurationError("Gemini 4 Neon requires store: true for background interactions.");
  }
  if (token === undefined) return;
  if (!readToken(token)) throw new ConfigurationError("Gemini 4 Neon requires a non-empty continuation token.");
  if (input.store === false ? input.input === undefined || !!input.previousInteractionId
    : input.input !== undefined || !input.previousInteractionId) {
    throw new ConfigurationError("Gemini 4 Neon stored continuations require previousInteractionId without input. Stateless continuations require the original input without previousInteractionId.");
  }
};

const nextInteractionInput = (input: InteractionCreateInput, token: string, id?: string): InteractionCreateInput => {
  const stored = input.store !== false;
  if (stored && !id) throw invalidContinuation("returned a stored continuation without an interaction ID.");
  return {
    ...input,
    input: stored ? undefined : input.input,
    previousInteractionId: stored ? id : undefined,
    continuationToken: token
  };
};

export const createNeonInteraction = async (
  input: InteractionCreateInput,
  send: (segment: InteractionCreateInput) => Promise<Interaction>,
  signal: AbortSignal
): Promise<Interaction> => {
  let current = input;
  const nextToken = continuationTokens();
  const segments: Interaction[] = [];
  let usage: TokenUsage | undefined;
  while (true) {
    signal.throwIfAborted();
    const segment = await send(current);
    if (!segments.length && segment.status !== "requires_continuation") return segment;
    segments.push(segment);
    usage = addUsage(usage, segment.usage);
    if (segment.status !== "requires_continuation") {
      const outputText = segments.map((value) => value.outputText ?? "").join("");
      return {
        ...segment,
        continuationIds: segments.map((value) => value.id),
        initialInputTokens: segments[0]?.initialInputTokens ?? segments[0]?.usage?.inputTokens,
        steps: segments.flatMap((value) => value.steps ?? []),
        outputs: segments.flatMap((value) => value.outputs ?? []),
        outputText: outputText || undefined,
        usage
      };
    }
    current = nextInteractionInput(input, nextToken(segment.continuationToken), segment.id);
  }
};

export async function* streamNeonInteraction(
  input: InteractionCreateInput,
  first: AsyncIterable<StreamEvent>,
  send: (segment: InteractionCreateInput) => Promise<AsyncIterable<StreamEvent>>,
  signal: AbortSignal
): AsyncGenerator<StreamEvent> {
  const nextToken = continuationTokens();
  let events = first;
  let total: TokenUsage | undefined;
  let segmentCount = 1;

  while (true) {
    let finish: Extract<StreamEvent, { type: "finish" }> | undefined;
    let checkpoint: unknown;
    let id: string | undefined;
    for await (const event of events) {
      signal.throwIfAborted();
      if (event.type === "finish") {
        finish = event;
        continue;
      }
      if (event.type === "provider-data" && event.data && typeof event.data === "object" && !Array.isArray(event.data)) {
        const data = event.data as { interaction?: Record<string, unknown>; id?: unknown; continuation_token?: unknown };
        const interaction = data.interaction;
        id = readToken(interaction?.id ?? data.id) ?? id;
        checkpoint = interaction?.continuation_token ?? data.continuation_token ?? checkpoint;
      }
      yield event;
    }
    signal.throwIfAborted();
    if (!finish) throw invalidContinuation("interaction stream ended without a terminal event.");
    if (finish.providerFinishReason !== "requires_continuation") {
      yield segmentCount > 1 ? { ...finish, usage: addUsage(total, finish.usage), providerRequestCount: segmentCount } : finish;
      return;
    }
    segmentCount += 1;
    total = addUsage(total, finish.usage);
    events = await send(nextInteractionInput(input, nextToken(checkpoint), id));
  }
}
