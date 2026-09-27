import { ConfigurationError } from "./errors.js";
import { normalizeFinishReason } from "./messages.js";
import { streamSSE } from "./stream.js";
import type { JsonValue, StreamEvent, TokenUsage } from "./types.js";

export const chatCompletionsUsage = (value: any): TokenUsage | undefined => value ? {
  inputTokens: value.prompt_tokens,
  outputTokens: value.completion_tokens,
  totalTokens: value.total_tokens,
  cachedInputTokens: value.prompt_tokens_details?.cached_tokens ?? value.cachedContentTokenCount,
  reasoningTokens: value.completion_tokens_details?.reasoning_tokens ?? value.reasoning_tokens,
  cacheWriteTokens: value.prompt_tokens_details?.cache_write_tokens
} : undefined;

export const chatCompletionsArguments = (value: unknown): JsonValue => {
  if (typeof value !== "string" || !value.trim() || value.length > 1024 * 1024) {
    throw new ConfigurationError("Invalid or oversized Chat Completions tool arguments.");
  }
  try { return JSON.parse(value) as JsonValue; }
  catch { throw new ConfigurationError("Chat Completions returned malformed tool arguments."); }
};

/** Assemble the first Chat Completions choice, retaining terminal usage and validating tools before emission. */
export async function* streamChatCompletions(response: Response, provider: string): AsyncGenerator<StreamEvent> {
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let finish: string | undefined;
  let lastUsage: TokenUsage | undefined;
  try {
    for await (const event of streamSSE(response)) {
      if (event.data === "[DONE]") break;
      const json = JSON.parse(event.data);
      if (json.error) throw new ConfigurationError(`${provider} reported a Chat Completions stream error.`);
      if (json.usage) lastUsage = chatCompletionsUsage(json.usage);
      const choice = json.choices?.find((item: any) => item.index === 0) ?? json.choices?.find((item: any) => item.index === undefined);
      const delta = choice?.delta;
      if (typeof delta?.content === "string") yield { type: "text-delta", textDelta: delta.content } satisfies StreamEvent;
      if (typeof delta?.reasoning_content === "string") yield { type: "provider-data", provider, data: { type: "reasoning_content", reasoningContent: delta.reasoning_content } } satisfies StreamEvent;
      for (const call of delta?.tool_calls ?? []) {
        if (!Number.isInteger(call.index) || call.index < 0 || call.index >= 128) throw new ConfigurationError("Invalid Chat Completions tool index.");
        const current = calls.get(call.index) ?? { id: "", name: "", args: "" };
        if (call.id && current.id && current.id !== call.id) throw new ConfigurationError("Conflicting Chat Completions tool IDs.");
        current.id ||= call.id ?? "";
        current.name += call.function?.name ?? "";
        current.args += call.function?.arguments ?? "";
        if (current.args.length > 1024 * 1024) throw new ConfigurationError("Oversized Chat Completions tool arguments.");
        calls.set(call.index, current);
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
    }
    if (!finish) throw new ConfigurationError("Chat Completions stream ended without a finish reason.");
    // Forced tool choices can terminate with stop; truncated or filtered calls remain non-executable.
    let hasToolCalls = false;
    if (finish === "tool_calls" || finish === "function_call" || finish === "stop") {
      const completed = [...calls.entries()].sort(([left], [right]) => left - right).map(([, call]) => {
        if (!call.id || !call.name) throw new ConfigurationError("Incomplete Chat Completions tool call.");
        return { id: call.id, name: call.name, input: chatCompletionsArguments(call.args) };
      });
      if (new Set(completed.map((call) => call.id)).size !== completed.length) throw new ConfigurationError("Duplicate Chat Completions tool IDs.");
      hasToolCalls = completed.length > 0;
      for (const toolCall of completed) yield { type: "tool-call", toolCall } satisfies StreamEvent;
    }
    yield { type: "finish", finishReason: hasToolCalls ? "tool-calls" : normalizeFinishReason(finish), providerFinishReason: finish, usage: lastUsage } satisfies StreamEvent;
  } finally {
    await response.body?.cancel().catch(() => {});
  }
}
