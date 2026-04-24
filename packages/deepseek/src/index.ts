import { toJSONSchema } from "zod";

import {
  ConfigurationError,
  ProviderHTTPError,
  UnsupportedFeatureError,
  createProviderAdapter,
  isCallableToolDefinition,
  normalizeFinishReason,
  providerDataPart,
  streamSSE,
  withRetry,
  withTimeoutSignal,
  type CallableProviderAdapter,
  type GenerateResult,
  type LanguageModel,
  type ModelCapabilities,
  type ModelGenerateInput,
  type ModelMessage,
  type ProviderAdapter,
  type StreamEvent
} from "@zhivex-ai/core";

export interface DeepSeekProviderOptions {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof globalThis.fetch;
}

export interface DeepSeekLanguageModelOptions {
  thinking?: {
    type: "enabled" | "disabled";
  };
  reasoning_effort?: "high" | "max";
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  user?: string;
  tool_choice?: "none" | "auto" | "required" | { type: "function"; function: { name: string } };
  [key: string]: unknown;
}

const capabilities: ModelCapabilities = {
  streaming: true,
  tools: true,
  structuredOutput: true,
  jsonMode: true,
  toolChoice: true,
  parallelToolCalls: true,
  vision: false,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
  reasoning: true,
  webSearch: false,
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

const reasoningContentFromMessage = (message: ModelMessage) =>
  message.parts
    .filter((part) => {
      if (part.type !== "provider-data" || part.provider !== "deepseek") {
        return false;
      }

      const data = part.data as Record<string, unknown>;
      return data.type === "reasoning_content" && typeof data.reasoningContent === "string";
    })
    .map((part) => (part.type === "provider-data" ? String((part.data as Record<string, unknown>).reasoningContent) : ""))
    .join("");

const jsonHeaders = (apiKey: string) => ({
  "content-type": "application/json",
  authorization: `Bearer ${apiKey}`
});

const parseJson = async (response: Response) => {
  if (!response.ok) {
    const body = await response.text();
    throw new ProviderHTTPError(`DeepSeek request failed with status ${response.status}.`, response.status, {
      responseBody: body
    });
  }

  return response.json();
};

const mapContentParts = (message: ModelMessage) => {
  const textParts = message.parts.filter((part) => part.type === "text");
  return textParts.map((part) => part.text).join("");
};

const mapMessages = (messages: ModelMessage[]) =>
  messages.map((message) => {
    if (message.role === "tool") {
      const toolResult = message.parts.find((part) => part.type === "tool-result");

      return {
        role: "tool",
        tool_call_id: toolResult?.type === "tool-result" ? toolResult.toolResult.toolCallId : undefined,
        content:
          toolResult?.type === "tool-result"
            ? JSON.stringify(toolResult.toolResult.isError ? toolResult.toolResult.error : toolResult.toolResult.output)
            : ""
      };
    }

    const toolCalls = message.parts
      .filter((part) => part.type === "tool-call")
      .map((part) => ({
        id: part.toolCall.id,
        type: "function",
        function: {
          name: part.toolCall.name,
          arguments: JSON.stringify(part.toolCall.input)
        }
      }));

    const payload: Record<string, unknown> = {
      role: message.role,
      content: mapContentParts(message)
    };

    const reasoningContent = reasoningContentFromMessage(message);
    if (reasoningContent) {
      payload.reasoning_content = reasoningContent;
    }

    if (toolCalls.length) {
      payload.tool_calls = toolCalls;
    }

    return payload;
  });

const mapTools = (tools: ModelGenerateInput["tools"]) =>
  tools
    ? (() => {
        const toolDefinitions = Object.values(tools);
        const callableTools = toolDefinitions.filter(isCallableToolDefinition);
        if (callableTools.length !== toolDefinitions.length) {
          throw new UnsupportedFeatureError('Provider "deepseek" does not support hosted tools.');
        }

        return callableTools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: toJSONSchema(tool.schema)
          }
        }));
      })()
    : undefined;

const mapToolChoice = (toolChoice: ModelGenerateInput["toolChoice"]) => {
  if (!toolChoice) {
    return undefined;
  }

  if (typeof toolChoice === "string") {
    return toolChoice;
  }

  return {
    type: "function",
    function: {
      name: toolChoice.toolName
    }
  };
};

const mapStructuredOutput = (input: ModelGenerateInput) => {
  if (!input.structuredOutput || input.structuredOutput.mode !== "native") {
    return undefined;
  }

  return {
    type: "json_object"
  };
};

const mapReasoningEffort = (effort: NonNullable<ModelGenerateInput["reasoning"]>["effort"]) => {
  if (effort === "xhigh") {
    return "max";
  }

  if (!effort || effort === "none") {
    return undefined;
  }

  return "high";
};

const mapReasoning = (input: ModelGenerateInput) => {
  if (!input.reasoning) {
    return undefined;
  }

  if (input.reasoning.budgetTokens !== undefined) {
    throw new UnsupportedFeatureError('Provider "deepseek" does not support "reasoning.budgetTokens".');
  }

  const thinking = input.reasoning.effort === "none" ? { type: "disabled" as const } : { type: "enabled" as const };
  const reasoningEffort = mapReasoningEffort(input.reasoning.effort);

  return {
    thinking,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {})
  };
};

const hasPreservedReasoning = (messages: ModelMessage[]) =>
  messages.some((message) => message.role === "assistant" && reasoningContentFromMessage(message));

const parseAssistantMessage = (message: any): ModelMessage => ({
  role: "assistant",
  parts: [
    ...(typeof message.reasoning_content === "string" && message.reasoning_content
      ? [providerDataPart("deepseek", { type: "reasoning_content", reasoningContent: message.reasoning_content })]
      : []),
    ...(typeof message.content === "string" && message.content
      ? [{ type: "text", text: message.content } as const]
      : []),
    ...((message.tool_calls ?? []).map((call: any) => ({
      type: "tool-call" as const,
      toolCall: {
        id: call.id,
        name: call.function.name,
        input: JSON.parse(call.function.arguments ?? "{}")
      }
    })) ?? [])
  ]
});

class DeepSeekLanguageModel implements LanguageModel<DeepSeekLanguageModelOptions> {
  readonly provider = "deepseek";
  readonly capabilities = capabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async generate(input: ModelGenerateInput<DeepSeekLanguageModelOptions>): Promise<GenerateResult> {
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/chat/completions`, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            signal,
            body: JSON.stringify({
              model: this.modelId,
              messages: mapMessages(input.messages),
              tools: mapTools(input.tools),
              tool_choice: mapToolChoice(input.toolChoice),
              response_format: mapStructuredOutput(input),
              temperature: input.temperature,
              max_tokens: input.maxTokens,
              stream: false,
              ...(hasPreservedReasoning(input.messages) ? { preserve_thinking: true } : {}),
              ...input.providerOptions,
              ...mapReasoning(input)
            })
          }),
        input
      );

      const json = await parseJson(response);
      const choice = json.choices?.[0];
      const message = choice?.message ?? {};
      const assistantMessage = parseAssistantMessage(message);

      return {
        messages: [assistantMessage],
        text: assistantMessage.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
        finishReason: normalizeFinishReason(choice?.finish_reason),
        providerFinishReason: choice?.finish_reason,
        usage: {
          inputTokens: json.usage?.prompt_tokens,
          outputTokens: json.usage?.completion_tokens,
          totalTokens: json.usage?.total_tokens
        },
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }

  async stream(input: ModelGenerateInput<DeepSeekLanguageModelOptions>): Promise<AsyncIterable<StreamEvent>> {
    const { signal, cleanup } = withTimeoutSignal(input);
    const response = await withRetry(
      () =>
        this.fetcher(`${this.baseURL}/chat/completions`, {
          method: "POST",
          headers: jsonHeaders(this.apiKey),
          signal,
          body: JSON.stringify({
            model: this.modelId,
            messages: mapMessages(input.messages),
            tools: mapTools(input.tools),
            tool_choice: mapToolChoice(input.toolChoice),
            response_format: mapStructuredOutput(input),
            temperature: input.temperature,
            max_tokens: input.maxTokens,
            stream: true,
            stream_options: { include_usage: true },
            ...(hasPreservedReasoning(input.messages) ? { preserve_thinking: true } : {}),
            ...input.providerOptions,
            ...mapReasoning(input)
          })
        }),
      input
    );

    return (async function* () {
      try {
        const toolBuffers = new Map<string, { name: string; args: string }>();
        let lastFinishReason: string | undefined;

        for await (const event of streamSSE(response)) {
          if (event.data === "[DONE]") {
            return;
          }

          const json = JSON.parse(event.data);
          const choice = json.choices?.[0];
          const delta = choice?.delta;
          const usage = json.usage ?? choice?.usage;

          if (!choice && usage) {
            yield {
              type: "finish",
              finishReason: normalizeFinishReason(lastFinishReason),
              providerFinishReason: lastFinishReason,
              usage: {
                inputTokens: usage.prompt_tokens,
                outputTokens: usage.completion_tokens,
                totalTokens: usage.total_tokens
              }
            } satisfies StreamEvent;
            continue;
          }

          if (delta?.reasoning_content) {
            yield {
              type: "provider-data",
              provider: "deepseek",
              data: {
                type: "reasoning_content",
                reasoningContent: delta.reasoning_content
              }
            } satisfies StreamEvent;
          }

          if (delta?.content) {
            yield { type: "text-delta", textDelta: delta.content } satisfies StreamEvent;
          }

          for (const toolCall of delta?.tool_calls ?? []) {
            const id = toolCall.id ?? `${toolCall.index}`;
            const existing = toolBuffers.get(id) ?? { name: toolCall.function?.name ?? "", args: "" };
            existing.name ||= toolCall.function?.name ?? "";
            existing.args += toolCall.function?.arguments ?? "";
            toolBuffers.set(id, existing);

            if (choice?.finish_reason === "tool_calls") {
              yield {
                type: "tool-call",
                toolCall: {
                  id,
                  name: existing.name,
                  input: JSON.parse(existing.args || "{}")
                }
              } satisfies StreamEvent;
            }
          }

          if (choice?.finish_reason) {
            lastFinishReason = choice.finish_reason;
            yield {
              type: "finish",
              finishReason: normalizeFinishReason(choice.finish_reason),
              providerFinishReason: choice.finish_reason,
              usage: usage
                ? {
                    inputTokens: usage.prompt_tokens,
                    outputTokens: usage.completion_tokens,
                    totalTokens: usage.total_tokens
                  }
                : undefined
            } satisfies StreamEvent;
          }
        }
      } finally {
        cleanup();
      }
    })();
  }
}

export const createDeepSeek = (
  options: DeepSeekProviderOptions = {}
): CallableProviderAdapter & ProviderAdapter & { rawFetch: typeof globalThis.fetch } => {
  const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new ConfigurationError("Missing DeepSeek API key.");
  }

  const baseURL = (options.baseURL ?? "https://api.deepseek.com").replace(/\/+$/, "");
  const fetcher = options.fetch ?? globalThis.fetch;

  return createProviderAdapter({
    name: "deepseek",
    languageModel: (modelId) => new DeepSeekLanguageModel(modelId, apiKey, baseURL, fetcher),
    rawFetch: fetcher
  });
};
