import {
  createHash
} from "node:crypto";
import {
  fingerprintAgentHarness
} from "../agent-harness.js";
import {
  ValidationError
} from "../errors.js";
import {
  createTextMessage
} from "../messages.js";
import type {
  AgentCompactionOptions,
  AgentCompactionReason,
  AgentCompactionRecord,
  AgentCompactionResult,
  AgentRunState,
  ModelMessage
} from "../types.js";

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

export const compactAgentMessages = async <TContext>(
  options: AgentCompactionOptions<TContext>,
  state: AgentRunState,
  messages: readonly ModelMessage[],
  beforeStep: number,
  context: TContext | undefined,
  abortSignal: AbortSignal | undefined,
  lifecycle?: {
    before: (id: string, sourceDigest: string) => Promise<void>;
    returned: (result: AgentCompactionResult) => Promise<void>;
    failed: () => Promise<void>;
  }
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
  // Preserve whole correlated groups even when approval messages or parallel
  // tool results separate a call from its result. Moving the boundary can expose
  // another crossing dependency, so resolve it to a fixed point.
  const origins = new Map<string, number>();
  const dependencies: Array<{ from: number; to: number }> = [];
  messages.forEach((message, index) => {
    for (const part of message.parts) {
      let origin: string | undefined;
      let reference: string | undefined;
      if (part.type === "tool-call") origin = `tool:${part.toolCall.id}`;
      if (part.type === "tool-result") reference = `tool:${part.toolResult.toolCallId}`;
      if (part.type === "provider-data" && typeof part.data === "object" && part.data !== null && !Array.isArray(part.data)) {
        if (part.data.type === "mcp_approval_request" && typeof part.data.id === "string") {
          origin = `approval:${part.provider}:${part.data.id}`;
        }
        if (part.data.type === "mcp_approval_response" && typeof part.data.approval_request_id === "string") {
          reference = `approval:${part.provider}:${part.data.approval_request_id}`;
        }
      }
      if (origin) origins.set(origin, index);
      const from = reference ? origins.get(reference) : undefined;
      if (from !== undefined) dependencies.push({ from, to: index });
    }
  });
  let previousCut: number;
  do {
    previousCut = cut;
    for (const { from, to } of dependencies) {
      if (from < cut && to >= cut) cut = from;
    }
  } while (cut !== previousCut);
  if (cut <= systemCount) {
    throw new ValidationError("Agent compaction cannot satisfy its limits without removing protected messages.");
  }

  const compactedMessages = structuredClone(messages.slice(systemCount, cut));
  const retainedMessages = structuredClone(messages.slice(cut));
  const sourceDigest = fingerprintAgentHarness(messages);
  const id = `cmp_${createHash("sha256")
    .update(`${state.runId}\0${beforeStep}\0${sourceDigest}`)
    .digest("hex")}`;
  await lifecycle?.before(id, sourceDigest);
  let result: AgentCompactionResult;
  try {
    result = await options.compactor({
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
  } catch (error) {
    await lifecycle?.failed();
    throw error;
  }
  await lifecycle?.returned(result);
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
