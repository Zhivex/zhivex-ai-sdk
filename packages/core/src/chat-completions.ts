import { toJSONSchema } from "zod";
import { ConfigurationError, ProviderHTTPError, UnsupportedFeatureError } from "./errors.js";
import { imageInputToDataUrl } from "./image-input.js";
import { normalizeFinishReason } from "./messages.js";
import { readErrorBodyWithLimit, readJsonWithLimit } from "./response.js";
import { withRetry, withTimeoutSignal } from "./runtime.js";
import { streamSSE } from "./stream.js";
import { toolResultPayload } from "./realtime.js";
import { isCallableToolDefinition } from "./messages.js";
import type { GenerateResult, JsonValue, LanguageModel, ModelCapabilities, ModelGenerateInput, ModelMessage, StreamEvent, TokenUsage } from "./types.js";

/** Transport-only Chat Completions implementation. Callers own host/model policy and authentication. */
export interface ChatCompletionsTransportOptions {
  provider: string;
  modelId: string;
  capabilities: ModelCapabilities;
  send: (body: Record<string, unknown>, signal?: AbortSignal) => Promise<Response>;
  prepare?: (input: ModelGenerateInput) => ModelGenerateInput;
}

const usage = (value: any): TokenUsage | undefined => value ? {
  inputTokens: value.prompt_tokens,
  outputTokens: value.completion_tokens,
  totalTokens: value.total_tokens,
  cachedInputTokens: value.prompt_tokens_details?.cached_tokens ?? value.cachedContentTokenCount,
  reasoningTokens: value.completion_tokens_details?.reasoning_tokens ?? value.reasoning_tokens
} : undefined;

const argumentsValue = (value: unknown): JsonValue => {
  if (typeof value !== "string" || !value.trim() || value.length > 1024 * 1024) {
    throw new ConfigurationError("Invalid or oversized Chat Completions tool arguments.");
  }
  try { return JSON.parse(value) as JsonValue; }
  catch { throw new ConfigurationError("Chat Completions returned malformed tool arguments."); }
};

const mapMessages = (input: ModelGenerateInput, provider: string): Record<string, unknown>[] => input.messages.flatMap<Record<string, unknown>>((message) => {
  if (message.role === "tool") return message.parts.filter((part) => part.type === "tool-result").map((part) => ({
    role: "tool", tool_call_id: part.toolResult.toolCallId,
    content: JSON.stringify(input.toolResultFormat === "envelope" ? toolResultPayload(part.toolResult)
      : part.toolResult.isError ? part.toolResult.error : part.toolResult.output) ?? "null"
  }));
  const content: unknown[] = [];
  const calls: unknown[] = [];
  let reasoning = "";
  for (const part of message.parts) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    else if (part.type === "image") content.push({ type: "image_url", image_url: { url: imageInputToDataUrl(part) } });
    else if (part.type === "tool-call") calls.push({ id: part.toolCall.id, type: "function", function: { name: part.toolCall.name, arguments: JSON.stringify(part.toolCall.input) } });
    else if (part.type === "provider-data") {
      const data = part.data as Record<string, unknown>;
      if (part.provider === provider && data?.type === "reasoning_content" && typeof data.reasoningContent === "string") reasoning += data.reasoningContent;
    } else throw new UnsupportedFeatureError(`Provider "${provider}" Chat Completions does not support message part "${part.type}".`);
  }
  const textOnly = content.every((part: any) => part.type === "text");
  return [{ role: message.role, content: textOnly ? content.map((part: any) => part.text).join("") : content,
    ...(calls.length ? { tool_calls: calls } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}) }];
});

export const createChatCompletionsModel = (options: ChatCompletionsTransportOptions): LanguageModel => {
  const prepare = (raw: ModelGenerateInput, stream: boolean) => {
    const input = options.prepare?.(raw) ?? raw;
    if (stream && !options.capabilities.streaming) throw new UnsupportedFeatureError(`Model "${options.modelId}" does not support streaming.`);
    if (input.reasoning) throw new UnsupportedFeatureError("Chat Completions reasoning must be mapped by the host-specific adapter.");
    const tools = input.tools ? Object.values(input.tools).map((tool) => {
      if (!isCallableToolDefinition(tool)) throw new UnsupportedFeatureError(`Provider "${options.provider}" Chat Completions supports callable tools only.`);
      return { type: "function", function: { name: tool.name, description: tool.description, parameters: toJSONSchema(tool.schema) } };
    }) : undefined;
    if (tools?.length && !options.capabilities.tools) throw new UnsupportedFeatureError(`Model "${options.modelId}" does not support tools.`);
    if (input.toolChoice && !options.capabilities.toolChoice) throw new UnsupportedFeatureError(`Model "${options.modelId}" does not support tool choice.`);
    if (input.messages.some((m) => m.parts.some((p) => p.type === "image")) && !options.capabilities.vision) throw new UnsupportedFeatureError(`Model "${options.modelId}" does not support image inputs.`);
    if (input.structuredOutput?.mode === "native" && !options.capabilities.structuredOutput) throw new UnsupportedFeatureError(`Model "${options.modelId}" does not support native structured output.`);
    const extra = { ...(input.providerOptions ?? {}) };
    // A provider option cannot replace SDK-owned messages, tools, model or stream mode.
    for (const key of ["model", "messages", "tools", "stream", "stream_options"]) delete extra[key];
    const responseFormat = input.structuredOutput?.mode === "native" ? {
      type: "json_schema", json_schema: { name: input.structuredOutput.name ?? "response", strict: true, schema: toJSONSchema(input.structuredOutput.schema) }
    } : extra.response_format;
    if (extra.tool_choice !== undefined && !input.toolChoice && !options.capabilities.toolChoice) throw new UnsupportedFeatureError(`Model "${options.modelId}" does not support tool choice.`);
    if (extra.parallel_tool_calls === true && !options.capabilities.parallelToolCalls) throw new UnsupportedFeatureError(`Model "${options.modelId}" does not support parallel tool calls.`);
    const formatType = responseFormat && typeof responseFormat === "object" ? (responseFormat as Record<string, unknown>).type : undefined;
    if (formatType === "json_schema" && !options.capabilities.structuredOutput) throw new UnsupportedFeatureError(`Model "${options.modelId}" does not support native structured output.`);
    if (formatType === "json_object" && !options.capabilities.jsonMode) throw new UnsupportedFeatureError(`Model "${options.modelId}" does not support JSON mode.`);
    return { input, body: {
      ...extra, model: options.modelId, messages: mapMessages(input, options.provider),
      ...(tools ? { tools } : {}),
      ...(input.toolChoice ? { tool_choice: typeof input.toolChoice === "string" ? input.toolChoice : { type: "function", function: { name: input.toolChoice.toolName } } } : {}),
      ...(responseFormat ? { response_format: responseFormat } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
      stream, ...(stream ? { stream_options: { include_usage: true } } : {})
    } };
  };
  const send = async (body: Record<string, unknown>, input: ModelGenerateInput, signal?: AbortSignal) => withRetry(async () => {
    const response = await options.send(body, signal);
    if (!response.ok) throw new ProviderHTTPError(`${options.provider} Chat Completions failed with status ${response.status}.`, response.status, { responseBody: await readErrorBodyWithLimit(response) });
    return response;
  }, { ...input, abortSignal: signal });
  return {
    provider: options.provider, modelId: options.modelId, capabilities: options.capabilities,
    async generate(raw): Promise<GenerateResult> {
      const { input, body } = prepare(raw, false);
      const { signal, cleanup } = withTimeoutSignal(input);
      try {
        const json: any = await readJsonWithLimit(await send(body, input, signal), { maxBytes: 128 * 1024 * 1024 });
        if (json.error || !json.choices?.[0]?.message) throw new ConfigurationError(`${options.provider} returned an invalid Chat Completions response.`);
        const choice = json.choices[0];
        const message = choice.message;
        const text = typeof message.content === "string" ? message.content : "";
        const parts: ModelMessage["parts"] = text ? [{ type: "text", text }] : [];
        if (typeof message.reasoning_content === "string") parts.push({ type: "provider-data", provider: options.provider, data: { type: "reasoning_content", reasoningContent: message.reasoning_content } });
        for (const call of choice.finish_reason === "length" || choice.finish_reason === "content_filter" ? [] : message.tool_calls ?? []) {
          if (!call.id || !call.function?.name) throw new ConfigurationError("Chat Completions returned an incomplete tool call.");
          parts.push({ type: "tool-call", toolCall: { id: call.id, name: call.function.name, input: argumentsValue(call.function.arguments) } });
        }
        const toolIds = parts.filter((part) => part.type === "tool-call").map((part) => part.toolCall.id);
        if (new Set(toolIds).size !== toolIds.length) throw new ConfigurationError("Duplicate Chat Completions tool IDs.");
        return { text, messages: [{ role: "assistant", parts }], finishReason: normalizeFinishReason(choice.finish_reason), providerFinishReason: choice.finish_reason, usage: usage(json.usage), rawResponse: json };
      } finally { cleanup(); }
    },
    async stream(raw): Promise<AsyncIterable<StreamEvent>> {
      const { input, body } = prepare(raw, true);
      const { signal, cleanup } = withTimeoutSignal(input);
      let response: Response;
      try { response = await send(body, input, signal); }
      catch (error) { cleanup(); throw error; }
      return (async function* () {
        const calls = new Map<number, { id: string; name: string; args: string }>();
        let finish: string | undefined;
        let lastUsage: TokenUsage | undefined;
        try {
          for await (const event of streamSSE(response)) {
            if (event.data === "[DONE]") break;
            const json = JSON.parse(event.data);
            if (json.error) throw new ConfigurationError(`${options.provider} reported a Chat Completions stream error.`);
            if (json.usage) lastUsage = usage(json.usage);
            const choice = json.choices?.find((item: any) => item.index === 0) ?? json.choices?.[0];
            const delta = choice?.delta;
            if (typeof delta?.content === "string") yield { type: "text-delta", textDelta: delta.content } satisfies StreamEvent;
            if (typeof delta?.reasoning_content === "string") yield { type: "provider-data", provider: options.provider, data: { type: "reasoning_content", reasoningContent: delta.reasoning_content } } satisfies StreamEvent;
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
          // Do not execute partial tool calls from truncated or interrupted streams.
          if (finish === "tool_calls" || finish === "function_call") {
            const completed = [...calls.values()].map((call) => {
              if (!call.id || !call.name) throw new ConfigurationError("Incomplete Chat Completions tool call.");
              return { id: call.id, name: call.name, input: argumentsValue(call.args) };
            });
            if (new Set(completed.map((call) => call.id)).size !== completed.length) throw new ConfigurationError("Duplicate Chat Completions tool IDs.");
            for (const toolCall of completed) yield { type: "tool-call", toolCall } satisfies StreamEvent;
          }
          yield { type: "finish", finishReason: normalizeFinishReason(finish), providerFinishReason: finish, usage: lastUsage } satisfies StreamEvent;
        } finally { cleanup(); }
      })();
    }
  };
};
