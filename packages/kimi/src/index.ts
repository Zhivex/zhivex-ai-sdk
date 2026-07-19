import { z, toJSONSchema } from "zod";

import {
  ConfigurationError,
  ProviderHTTPError,
  UnsupportedFeatureError,
  createProviderAdapter,
  isCallableToolDefinition,
  normalizeFinishReason,
  providerDataPart,
  serializeJsonValue,
  streamSSE,
  tool,
  withRetry,
  withTimeoutSignal,
  type CallableProviderAdapter,
  type GenerateResult,
  type JsonValue,
  type LanguageModel,
  type ModelCapabilities,
  type ModelGenerateInput,
  type ModelMessage,
  type ProviderAdapter,
  type StreamEvent,
  type ToolSet
} from "@zhivex-ai/core";

export interface KimiProviderOptions {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof globalThis.fetch;
}

export interface KimiLanguageModelOptions {
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  n?: number;
  stop?: string | string[];
  seed?: number;
  user?: string;
  max_completion_tokens?: number;
  reasoning_effort?: "max";
  thinking?: {
    type: "enabled" | "disabled";
    keep?: "all" | null;
  };
  tool_choice?: "none" | "auto" | "required" | { type: "function"; function: { name: string } };
  [key: string]: unknown;
}

export interface KimiFormulaToolOptions {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof globalThis.fetch;
}

export interface KimiOfficialToolOptions extends KimiFormulaToolOptions {
  name: string;
  formulaUri: string;
  description?: string;
  parameters?: JsonValue;
  requiresApproval?: boolean;
}

export interface KimiFormulaToolsOptions extends KimiFormulaToolOptions {
  formulas: string[];
  requiresApproval?: boolean;
}

const capabilities: ModelCapabilities = {
  streaming: true,
  tools: true,
  structuredOutput: true,
  jsonMode: true,
  toolChoice: true,
  parallelToolCalls: true,
  vision: true,
  files: true,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
  reasoning: false,
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

const isKimiK3Model = (modelId: string) => /^kimi-k3(?:$|-)/i.test(modelId);
const isKimiK27CodeModel = (modelId: string) => /^kimi-k2\.7-code(?:$|-)/i.test(modelId);
const isKimiK26Model = (modelId: string) => /^kimi-k2\.6(?:$|-)/i.test(modelId);
const supportsKimiReasoning = (modelId: string) =>
  isKimiK3Model(modelId) || /kimi-k2\.7-code|kimi-k2\.6|kimi-k2\.5|kimi-k2-thinking/i.test(modelId);

type KimiMessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "video_url"; video_url: { url: string } };

type KimiMediaReference = string | ({ url: string } & Record<string, JsonValue>);
type KimiMultimodalContentBlock =
  | ({ type: "text"; text: string } & Record<string, JsonValue>)
  | ({ type: "image_url"; image_url: KimiMediaReference } & Record<string, JsonValue>)
  | ({ type: "video_url"; video_url: KimiMediaReference } & Record<string, JsonValue>);

const toKimiMediaUrl = (data: string, mediaType: string) => {
  if (/^https?:\/\//i.test(data)) {
    throw new UnsupportedFeatureError(
      'Provider "kimi" does not support public image or video URLs. Use base64 data or an "ms://" file reference.'
    );
  }

  return /^(?:data:|ms:\/\/)/i.test(data) ? data : `data:${mediaType};base64,${data}`;
};

const isKimiMultimodalContentBlock = (value: unknown): value is KimiMultimodalContentBlock => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const block = value as Record<string, unknown>;
  if (block.type === "text") {
    return typeof block.text === "string";
  }
  if (block.type !== "image_url" && block.type !== "video_url") {
    return false;
  }
  const media = block[block.type];
  return (
    typeof media === "string" ||
    Boolean(
      media &&
      typeof media === "object" &&
      !Array.isArray(media) &&
      typeof (media as Record<string, unknown>).url === "string"
    )
  );
};

const kimiToolMetadata = (definition: { formulaUri: string; parameters?: JsonValue }) => ({
  "kimi.formula_uri": definition.formulaUri,
  ...(definition.parameters ? { "kimi.tool_schema": definition.parameters } : {})
});

const kimiFormulaToolSchema = (toolDefinition: { metadata?: Record<string, JsonValue>; schema: z.ZodTypeAny }) =>
  toolDefinition.metadata?.["kimi.tool_schema"] ?? toJSONSchema(toolDefinition.schema);

const resolveFormulaConfig = (options: KimiFormulaToolOptions) => {
  const apiKey = options.apiKey ?? process.env.KIMI_API_KEY ?? process.env.MOONSHOT_API_KEY;
  if (!apiKey) {
    throw new ConfigurationError("Missing Kimi API key for official Formula tool execution.");
  }
  return {
    apiKey,
    baseURL: (options.baseURL ?? process.env.KIMI_BASE_URL ?? process.env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai/v1").replace(/\/+$/, ""),
    fetcher: options.fetch ?? globalThis.fetch
  };
};

const callKimiFormula = async (
  options: KimiFormulaToolOptions,
  formulaUri: string,
  name: string,
  input: unknown
): Promise<JsonValue> => {
  const { apiKey, baseURL, fetcher } = resolveFormulaConfig(options);
  const response = await fetcher(`${baseURL}/formulas/${formulaUri}/fibers`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      name,
      arguments: JSON.stringify(input ?? {})
    })
  });
  const json = await parseJson(response);
  return serializeJsonValue(json);
};

const reasoningContentFromMessage = (message: ModelMessage) =>
  message.parts
    .filter((part) => {
      if (part.type !== "provider-data" || part.provider !== "kimi") {
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
    throw new ProviderHTTPError(`Kimi request failed with status ${response.status}.`, response.status, {
      responseBody: body
    });
  }

  return response.json();
};

const mapContentParts = (message: ModelMessage) => {
  const hasMedia = message.parts.some(
    (part) => part.type === "image" || (part.type === "file" && /^(?:image|video)\//i.test(part.mediaType))
  );

  if (!hasMedia) {
    return message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  }

  return message.parts.flatMap<KimiMessageContentPart>((part) => {
    if (part.type === "text") {
      return [{ type: "text", text: part.text }];
    }
    if (part.type === "image") {
      return [
        {
          type: "image_url",
          image_url: {
            url: toKimiMediaUrl(part.image, part.mediaType ?? "image/png")
          }
        }
      ];
    }
    if (part.type === "file" && /^(?:image|video)\//i.test(part.mediaType)) {
      const url = toKimiMediaUrl(part.data, part.mediaType);
      return [
        part.mediaType.toLowerCase().startsWith("video/")
          ? {
            type: "video_url",
            video_url: {
              url
            }
          }
          : {
            type: "image_url",
            image_url: {
              url
            }
          }
      ];
    }
    return [];
  });
};

const mapToolResultContent = (toolResult: Extract<ModelMessage["parts"][number], { type: "tool-result" }>["toolResult"]) => {
  const output = toolResult.isError ? toolResult.error : toolResult.output;
  if (!Array.isArray(output) || !output.every(isKimiMultimodalContentBlock)) {
    return JSON.stringify(output);
  }

  return output.map((block) => {
    if (block.type === "text") {
      return block;
    }
    const media = block.type === "image_url" ? block.image_url : block.video_url;
    const url = typeof media === "string" ? media : media.url;
    const mappedUrl = toKimiMediaUrl(url, block.type === "image_url" ? "image/png" : "video/mp4");
    const mappedMedia = typeof media === "string" ? mappedUrl : { ...media, url: mappedUrl };
    return block.type === "image_url"
      ? { ...block, image_url: mappedMedia }
      : { ...block, video_url: mappedMedia };
  });
};

const mapMessages = (messages: ModelMessage[]) =>
  messages.map((message) => {
    if (message.role === "tool") {
      const toolResult = message.parts.find((part) => part.type === "tool-result");

      return {
        role: "tool",
        tool_call_id: toolResult?.type === "tool-result" ? toolResult.toolResult.toolCallId : undefined,
        content: toolResult?.type === "tool-result" ? mapToolResultContent(toolResult.toolResult) : ""
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
          throw new UnsupportedFeatureError('Provider "kimi" does not support hosted tools.');
        }

        return callableTools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: kimiFormulaToolSchema(tool)
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
    type: "json_schema",
    json_schema: {
      name: input.structuredOutput.name ?? "response",
      strict: true,
      schema: toJSONSchema(input.structuredOutput.schema)
    }
  };
};

const mapReasoning = (modelId: string, input: ModelGenerateInput) => {
  if (!input.reasoning) {
    return undefined;
  }

  if (input.reasoning.budgetTokens !== undefined) {
    throw new UnsupportedFeatureError('Provider "kimi" does not support "reasoning.budgetTokens".');
  }

  if (isKimiK3Model(modelId)) {
    if (input.reasoning.effort !== undefined && input.reasoning.effort !== "max") {
      throw new UnsupportedFeatureError('Provider "kimi" only supports "reasoning.effort=max" for Kimi K3 models.');
    }

    return input.reasoning.effort === "max" ? { reasoning_effort: "max" } : undefined;
  }

  if (input.reasoning.effort === "none" && isKimiK27CodeModel(modelId)) {
    throw new UnsupportedFeatureError('Provider "kimi" does not support disabling thinking for Kimi K2.7 Code models.');
  }

  if (isKimiK27CodeModel(modelId)) {
    return {
      thinking: {
        type: "enabled",
        keep: "all"
      }
    };
  }

  return {
    thinking: {
      type: input.reasoning.effort === "none" ? "disabled" : "enabled"
    }
  };
};

const validateFixedNumber = (
  modelName: string,
  parameter: string,
  value: unknown,
  expected: number
) => {
  if (value !== undefined && value !== expected) {
    const expectedLabel = parameter === "temperature" && expected === 1 ? "1.0" : String(expected);
    throw new UnsupportedFeatureError(
      `Provider "kimi" requires "${parameter}" to remain ${expectedLabel} for ${modelName} models.`
    );
  }
};

const assertKimiRequestCompatibility = (modelId: string, input: ModelGenerateInput<KimiLanguageModelOptions>) => {
  const providerOptions = input.providerOptions ?? {};
  const rawThinking = providerOptions.thinking;
  if (isKimiK3Model(modelId)) {
    if (rawThinking !== undefined) {
      throw new UnsupportedFeatureError(
        'Provider "kimi" does not support the K2.x "thinking" parameter for Kimi K3 models. Use "reasoning_effort=max".'
      );
    }
    if (providerOptions.reasoning_effort !== undefined && providerOptions.reasoning_effort !== "max") {
      throw new UnsupportedFeatureError('Provider "kimi" only supports "reasoning_effort=max" for Kimi K3 models.');
    }

    validateFixedNumber("Kimi K3", "temperature", input.temperature ?? providerOptions.temperature, 1);
    validateFixedNumber("Kimi K3", "top_p", providerOptions.top_p, 0.95);
    validateFixedNumber("Kimi K3", "n", providerOptions.n, 1);
    validateFixedNumber("Kimi K3", "presence_penalty", providerOptions.presence_penalty, 0);
    validateFixedNumber("Kimi K3", "frequency_penalty", providerOptions.frequency_penalty, 0);

    const requestedMaxTokens = input.maxTokens ?? providerOptions.max_completion_tokens;
    if (
      requestedMaxTokens !== undefined &&
      (!Number.isInteger(requestedMaxTokens) || requestedMaxTokens <= 0 || requestedMaxTokens > 1_048_576)
    ) {
      throw new UnsupportedFeatureError(
        'Provider "kimi" requires Kimi K3 max completion tokens to be an integer between 1 and 1048576.'
      );
    }
    return;
  }

  if (providerOptions.reasoning_effort !== undefined) {
    throw new UnsupportedFeatureError('Provider "kimi" only supports "reasoning_effort" for Kimi K3 models.');
  }

  if (!isKimiK27CodeModel(modelId)) {
    return;
  }

  if (rawThinking !== undefined) {
    const thinking =
      rawThinking && typeof rawThinking === "object" && !Array.isArray(rawThinking)
        ? (rawThinking as Record<string, unknown>)
        : undefined;
    if (thinking?.type !== "enabled" || thinking.keep !== "all") {
      throw new UnsupportedFeatureError(
        'Provider "kimi" only accepts "thinking={ type: enabled, keep: all }" for Kimi K2.7 Code models.'
      );
    }
  }

  validateFixedNumber("Kimi K2.7 Code", "temperature", input.temperature ?? providerOptions.temperature, 1);
  validateFixedNumber("Kimi K2.7 Code", "top_p", providerOptions.top_p, 0.95);
  validateFixedNumber("Kimi K2.7 Code", "n", providerOptions.n, 1);
  validateFixedNumber("Kimi K2.7 Code", "presence_penalty", providerOptions.presence_penalty, 0);
  validateFixedNumber("Kimi K2.7 Code", "frequency_penalty", providerOptions.frequency_penalty, 0);
};

const mapProviderOptions = (modelId: string, providerOptions: KimiLanguageModelOptions | undefined) => {
  const mapped = { ...(providerOptions ?? {}) };

  if (isKimiK3Model(modelId) || isKimiK27CodeModel(modelId)) {
    delete mapped.temperature;
    delete mapped.top_p;
    delete mapped.n;
    delete mapped.presence_penalty;
    delete mapped.frequency_penalty;
  }
  delete mapped.tool_choice;

  return mapped;
};

const mapMaxTokens = (modelId: string, maxTokens: number | undefined) => {
  if (maxTokens === undefined) {
    return {};
  }
  return isKimiK3Model(modelId) ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens };
};

const parseAssistantMessage = (message: any): ModelMessage => ({
  role: "assistant",
  parts: [
    ...(typeof message.reasoning_content === "string" && message.reasoning_content
      ? [providerDataPart("kimi", { type: "reasoning_content", reasoningContent: message.reasoning_content })]
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

class KimiLanguageModel implements LanguageModel<KimiLanguageModelOptions> {
  readonly provider = "kimi";
  readonly capabilities: ModelCapabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {
    this.capabilities = {
      ...capabilities,
      reasoning: supportsKimiReasoning(modelId),
      ...(isKimiK3Model(modelId)
        ? {
            reasoningEfforts: ["max" as const],
            contextCaching: true
          }
        : {})
    };
  }

  private mapToolChoice(
    input: ModelGenerateInput<KimiLanguageModelOptions>,
    reasoning: ReturnType<typeof mapReasoning>
  ) {
    const rawToolChoice = input.providerOptions?.tool_choice;
    const toolChoice = input.toolChoice ?? rawToolChoice;
    if (!toolChoice) {
      return undefined;
    }

    if (toolChoice === "required" && (isKimiK27CodeModel(this.modelId) || isKimiK26Model(this.modelId))) {
      throw new UnsupportedFeatureError(
        `Provider "kimi" does not support "toolChoice=required" for ${isKimiK27CodeModel(this.modelId) ? "Kimi K2.7 Code" : "Kimi K2.6"} models.`
      );
    }

    const rawThinking = input.providerOptions?.thinking;
    const mappedThinking = reasoning && "thinking" in reasoning ? reasoning.thinking : undefined;
    const reasoningEnabled =
      isKimiK3Model(this.modelId) ||
      isKimiK27CodeModel(this.modelId) ||
      mappedThinking?.type === "enabled" ||
      Boolean(rawThinking && typeof rawThinking === "object" && rawThinking.type === "enabled");
    if (reasoningEnabled && typeof toolChoice === "object") {
      throw new UnsupportedFeatureError(
        'Provider "kimi" does not support selecting a specific tool while reasoning is enabled. Use "toolChoice=required" on Kimi K3 or "auto"/"none".'
      );
    }

    return input.toolChoice === undefined ? rawToolChoice : mapToolChoice(input.toolChoice);
  }

  async generate(input: ModelGenerateInput<KimiLanguageModelOptions>): Promise<GenerateResult> {
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      assertKimiRequestCompatibility(this.modelId, input);
      const reasoning = mapReasoning(this.modelId, input);
      const providerOptions = mapProviderOptions(this.modelId, input.providerOptions);
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/chat/completions`, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            signal,
            body: JSON.stringify({
              ...providerOptions,
              model: this.modelId,
              messages: mapMessages(input.messages),
              tools: mapTools(input.tools),
              tool_choice: this.mapToolChoice(input, reasoning),
              response_format: mapStructuredOutput(input),
              temperature: isKimiK3Model(this.modelId) || isKimiK27CodeModel(this.modelId) ? undefined : input.temperature,
              ...mapMaxTokens(this.modelId, input.maxTokens),
              stream: false,
              ...reasoning
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
          cachedInputTokens: json.usage?.cached_tokens,
          outputTokens: json.usage?.completion_tokens,
          totalTokens: json.usage?.total_tokens
        },
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }

  async stream(input: ModelGenerateInput<KimiLanguageModelOptions>): Promise<AsyncIterable<StreamEvent>> {
    const { signal, cleanup } = withTimeoutSignal(input);
    assertKimiRequestCompatibility(this.modelId, input);
    const reasoning = mapReasoning(this.modelId, input);
    const providerOptions = mapProviderOptions(this.modelId, input.providerOptions);

    const response = await withRetry(
      () =>
        this.fetcher(`${this.baseURL}/chat/completions`, {
          method: "POST",
          headers: jsonHeaders(this.apiKey),
          signal,
          body: JSON.stringify({
            ...providerOptions,
            model: this.modelId,
            messages: mapMessages(input.messages),
            tools: mapTools(input.tools),
            tool_choice: this.mapToolChoice(input, reasoning),
            response_format: mapStructuredOutput(input),
            temperature: isKimiK3Model(this.modelId) || isKimiK27CodeModel(this.modelId) ? undefined : input.temperature,
            ...mapMaxTokens(this.modelId, input.maxTokens),
            stream: true,
            stream_options: { include_usage: true },
            ...reasoning
          })
        }),
      input
    );

    return (async function* () {
      try {
        const toolBuffers = new Map<number, { id: string; name: string; args: string }>();

        for await (const event of streamSSE(response)) {
          if (event.data === "[DONE]") {
            return;
          }

          const json = JSON.parse(event.data);
          const choice = json.choices?.[0];
          const delta = choice?.delta;

          if (delta?.reasoning_content) {
            yield {
              type: "provider-data",
              provider: "kimi",
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
            const index = typeof toolCall.index === "number" ? toolCall.index : 0;
            const existing = toolBuffers.get(index) ?? {
              id: "",
              name: toolCall.function?.name ?? "",
              args: ""
            };
            existing.id ||= toolCall.id ?? `${index}`;
            existing.name ||= toolCall.function?.name ?? "";
            existing.args += toolCall.function?.arguments ?? "";
            toolBuffers.set(index, existing);
          }

          if (choice?.finish_reason === "tool_calls") {
            for (const [index, toolCall] of toolBuffers) {
              yield {
                type: "tool-call",
                toolCall: {
                  id: toolCall.id || `${index}`,
                  name: toolCall.name,
                  input: JSON.parse(toolCall.args || "{}")
                }
              } satisfies StreamEvent;
            }
            toolBuffers.clear();
          }

          if (choice?.finish_reason) {
            yield {
              type: "finish",
              finishReason: normalizeFinishReason(choice.finish_reason),
              providerFinishReason: choice.finish_reason,
              usage: json.usage
                ? {
                    inputTokens: json.usage.prompt_tokens,
                    cachedInputTokens: json.usage.cached_tokens,
                    outputTokens: json.usage.completion_tokens,
                    totalTokens: json.usage.total_tokens
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

export const createKimi = (
  options: KimiProviderOptions = {}
): CallableProviderAdapter & ProviderAdapter & { rawFetch: typeof globalThis.fetch } => {
  const apiKey = options.apiKey ?? process.env.KIMI_API_KEY ?? process.env.MOONSHOT_API_KEY;
  if (!apiKey) {
    throw new ConfigurationError("Missing Kimi API key.");
  }

  const baseURL = options.baseURL ?? "https://api.moonshot.ai/v1";
  const fetcher = options.fetch ?? globalThis.fetch;

  return createProviderAdapter({
    name: "kimi",
    languageModel: (modelId) => new KimiLanguageModel(modelId, apiKey, baseURL, fetcher),
    rawFetch: fetcher
  });
};

export const kimiOfficialTool = (options: KimiOfficialToolOptions) =>
  tool({
    name: options.name,
    description: options.description,
    schema: z.any(),
    metadata: kimiToolMetadata({
      formulaUri: options.formulaUri,
      parameters: options.parameters
    }),
    requiresApproval: options.requiresApproval,
    execute: (input) => callKimiFormula(options, options.formulaUri, options.name, input)
  });

const kimiObjectSchema = (properties: Record<string, JsonValue>, required: string[] = []): JsonValue => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {})
});

export const kimiWebSearchTool = (options: KimiFormulaToolOptions & { requiresApproval?: boolean } = {}) =>
  kimiOfficialTool({
    ...options,
    name: "web_search",
    formulaUri: "moonshot/web-search:latest",
    description: "Search the web for current information.",
    parameters: kimiObjectSchema(
      {
        query: {
          type: "string",
          description: "The search query."
        }
      },
      ["query"]
    )
  });

export const kimiFetchTool = (options: KimiFormulaToolOptions & { requiresApproval?: boolean } = {}) =>
  kimiOfficialTool({
    ...options,
    name: "fetch",
    formulaUri: "moonshot/fetch:latest",
    description: "Fetch and convert URL content.",
    parameters: kimiObjectSchema(
      {
        url: {
          type: "string",
          description: "The URL to fetch."
        }
      },
      ["url"]
    )
  });

export const kimiCodeRunnerTool = (options: KimiFormulaToolOptions & { requiresApproval?: boolean } = {}) =>
  kimiOfficialTool({
    ...options,
    name: "code_runner",
    formulaUri: "moonshot/code_runner:latest",
    description: "Run Python code in Kimi Formula.",
    parameters: kimiObjectSchema(
      {
        code: {
          type: "string",
          description: "Python code to execute."
        }
      },
      ["code"]
    ),
    requiresApproval: options.requiresApproval ?? true
  });

export const kimiExcelTool = (options: KimiFormulaToolOptions & { requiresApproval?: boolean } = {}) =>
  kimiOfficialTool({
    ...options,
    name: "excel",
    formulaUri: "moonshot/excel:latest",
    description: "Analyze Excel or CSV content with Kimi Formula.",
    parameters: kimiObjectSchema({})
  });

export const kimiDateTool = (options: KimiFormulaToolOptions & { requiresApproval?: boolean } = {}) =>
  kimiOfficialTool({
    ...options,
    name: "date",
    formulaUri: "moonshot/date:latest",
    description: "Resolve date and time requests.",
    parameters: kimiObjectSchema({})
  });

export const kimiFormulaTools = async (options: KimiFormulaToolsOptions): Promise<ToolSet> => {
  const { apiKey, baseURL, fetcher } = resolveFormulaConfig(options);
  const result: ToolSet = {};

  for (const formulaUri of options.formulas) {
    const response = await fetcher(`${baseURL}/formulas/${formulaUri}/tools`, {
      headers: {
        authorization: `Bearer ${apiKey}`
      }
    });
    const json = await parseJson(response);
    for (const definition of json.tools ?? []) {
      const name = definition.function?.name;
      if (!name) {
        continue;
      }
      result[name] = kimiOfficialTool({
        apiKey,
        baseURL,
        fetch: fetcher,
        name,
        formulaUri,
        description: definition.function?.description,
        parameters: definition.function?.parameters,
        requiresApproval: options.requiresApproval
      });
    }
  }

  return result;
};
