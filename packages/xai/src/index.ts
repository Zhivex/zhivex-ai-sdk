import {
  ConfigurationError,
  ProviderHTTPError,
  UnsupportedFeatureError,
  createProviderAdapter,
  hostedTool,
  isHostedToolDefinition,
  normalizeMessages,
  withRetry,
  withTimeoutSignal,
  type CallableProviderAdapter,
  type FileDeleteInput,
  type FileGetInput,
  type FileListInput,
  type FilesClient,
  type FileUploadInput,
  type GenerateResult,
  type GroundedGenerateResult,
  type GroundedLanguageModel,
  type JsonValue,
  type LanguageModel,
  type ModelCapabilities,
  type ModelGenerateInput,
  type ModelMessage,
  type ProviderAdapter,
  type StreamEvent,
  type ToolSet,
  type UploadedFile
} from "@zhivex-ai/core";
import { createOpenAI } from "@zhivex-ai/openai";

export interface XAIProviderOptions {
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}

export interface XAILanguageModelOptions {
  apiMode?: "chat" | "responses";
  headers?: Record<string, string>;
  conversationId?: string;
  prompt_cache_key?: string;
  include?: string[];
  store?: boolean;
  parallel_tool_calls?: boolean;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  seed?: number;
  user?: string;
  [key: string]: unknown;
}

export interface XAIFileOptions {
  purpose?: string;
  expires_after?: number;
  order?: "asc" | "desc";
  sort_by?: "created_at" | "filename" | "size";
  filter?: string;
  [key: string]: unknown;
}

export interface XAIWebSearchToolConfig {
  allowed_domains?: string[];
  excluded_domains?: string[];
  enable_image_understanding?: boolean;
  enable_image_search?: boolean;
}

export interface XAIXSearchToolConfig {
  allowed_x_handles?: string[];
  excluded_x_handles?: string[];
  from_date?: string;
  to_date?: string;
  enable_image_understanding?: boolean;
}

export interface XAICodeExecutionToolConfig {
  [key: string]: JsonValue | undefined;
}

export interface XAIFileSearchToolConfig {
  vector_store_ids: string[];
  max_num_results?: number;
  filters?: Record<string, JsonValue>;
}

const baseCapabilities: ModelCapabilities = {
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
  fileSearch: true,
  contextCaching: true,
  reasoning: true,
  webSearch: true,
  agentCapabilities: {
    supportTier: "tier-b",
    toolChoiceNone: true,
    approvalRequests: false,
    hostedWebSearch: true,
    hostedFileSearch: true,
    remoteMcp: false,
    computerUse: false,
    codeExecution: true,
    toolsets: false
  }
};

const normalizedModelId = (modelId: string) => modelId.trim().toLowerCase();
const isGrok45 = (modelId: string) => /^grok-4\.5(?:[-@]|$)/.test(normalizedModelId(modelId));
const isGrok420MultiAgent = (modelId: string) => /^grok-4\.20(?:-\d{4})?-multi-agent(?:[-@]|$)/.test(normalizedModelId(modelId));
const isNonReasoningModel = (modelId: string) => /non-reasoning/.test(normalizedModelId(modelId));

const modelCapabilities = (modelId: string): ModelCapabilities => ({
  ...baseCapabilities,
  reasoning: !isNonReasoningModel(modelId),
  reasoningEfforts: isNonReasoningModel(modelId)
    ? undefined
    : isGrok45(modelId)
      ? ["low", "medium", "high"]
      : isGrok420MultiAgent(modelId)
        ? ["low", "medium", "high", "xhigh"]
        : ["none", "low", "medium", "high"]
});

const jsonHeaders = (apiKey: string) => ({
  "content-type": "application/json",
  authorization: `Bearer ${apiKey}`
});

const parseJson = async (response: Response) => {
  if (!response.ok) {
    const body = await response.text();
    throw new ProviderHTTPError(`xAI request failed with status ${response.status}.`, response.status, {
      responseBody: body
    });
  }
  return response.json();
};

const remapHTTPError = (error: unknown): never => {
  if (error instanceof ProviderHTTPError) {
    throw new ProviderHTTPError(`xAI request failed with status ${error.status}.`, error.status, {
      cause: error,
      responseBody: error.responseBody
    });
  }
  throw error;
};

const remapMessageProvider = (message: ModelMessage, from: string, to: string): ModelMessage => ({
  ...message,
  parts: message.parts.map((part) =>
    part.type === "provider-data" && part.provider === from
      ? { ...part, provider: to }
      : part
  )
});

const remapToolsForOpenAITransport = (tools: ToolSet | undefined): ToolSet | undefined =>
  tools
    ? Object.fromEntries(
        Object.entries(tools).map(([name, definition]) => [
          name,
          isHostedToolDefinition(definition) && definition.provider === "xai"
            ? { ...definition, provider: "openai" }
            : definition
        ])
      )
    : undefined;

const validateXAIInput = (modelId: string, input: ModelGenerateInput<XAILanguageModelOptions>) => {
  const reasoning = input.reasoning;
  if (reasoning?.budgetTokens !== undefined) {
    throw new UnsupportedFeatureError('Provider "xai" does not support "reasoning.budgetTokens".');
  }
  if (reasoning?.mode !== undefined || reasoning?.context !== undefined) {
    throw new UnsupportedFeatureError('Provider "xai" does not support "reasoning.mode" or "reasoning.context".');
  }
  if (reasoning?.includeThoughts) {
    throw new UnsupportedFeatureError(
      'Provider "xai" does not expose reasoning through "includeThoughts"; use providerOptions.include with encrypted reasoning when required.'
    );
  }
  if (isNonReasoningModel(modelId) && reasoning) {
    throw new UnsupportedFeatureError(`Provider "xai" model "${modelId}" does not support reasoning.`);
  }

  const effort = reasoning?.effort;
  const supportedEfforts = modelCapabilities(modelId).reasoningEfforts;
  if (effort && supportedEfforts && !supportedEfforts.includes(effort)) {
    throw new UnsupportedFeatureError(
      `Provider "xai" model "${modelId}" does not support reasoning effort "${effort}". Supported efforts: ${supportedEfforts.join(", ")}.`
    );
  }

  const providerOptions = input.providerOptions;
  if (
    providerOptions?.apiMode === "chat" &&
    Object.values(input.tools ?? {}).some(isHostedToolDefinition)
  ) {
    throw new UnsupportedFeatureError('Provider "xai" supports hosted tools through the Responses API only.');
  }
  const reasoningIsActive = Boolean(reasoning) || isGrok45(modelId);
  if (
    reasoningIsActive &&
    (providerOptions?.presence_penalty !== undefined ||
      providerOptions?.frequency_penalty !== undefined ||
      providerOptions?.stop !== undefined)
  ) {
    throw new UnsupportedFeatureError(
      `Provider "xai" model "${modelId}" does not support presence_penalty, frequency_penalty, or stop while reasoning is active.`
    );
  }
};

const resolveTransportOptions = (
  options: XAILanguageModelOptions | undefined,
  defaultHeaders: Record<string, string>
) => {
  const {
    conversationId,
    headers,
    apiMode = "responses",
    prompt_cache_key: promptCacheKey,
    ...bodyOptions
  } = options ?? {};
  const mergedHeaders = { ...defaultHeaders, ...headers };

  if (apiMode === "chat") {
    const cacheKey = conversationId ?? promptCacheKey;
    if (cacheKey) {
      mergedHeaders["x-grok-conv-id"] = cacheKey;
    }
    return {
      ...bodyOptions,
      apiMode,
      headers: mergedHeaders
    };
  }

  const include =
    bodyOptions.store === false
      ? [...new Set([...(Array.isArray(bodyOptions.include) ? bodyOptions.include : []), "reasoning.encrypted_content"])]
      : bodyOptions.include;

  return {
    ...bodyOptions,
    apiMode,
    headers: mergedHeaders,
    ...(include ? { include } : {}),
    ...(promptCacheKey ?? conversationId ? { prompt_cache_key: promptCacheKey ?? conversationId } : {})
  };
};

const prepareTransportInput = (
  input: ModelGenerateInput<XAILanguageModelOptions>,
  defaultHeaders: Record<string, string>
): ModelGenerateInput => ({
  ...input,
  messages: input.messages.map((message) => remapMessageProvider(message, "xai", "openai")),
  tools: remapToolsForOpenAITransport(input.tools),
  providerOptions: resolveTransportOptions(input.providerOptions, defaultHeaders)
});

const remapGenerateResult = (result: GenerateResult): GenerateResult => ({
  ...result,
  ...(result.message ? { message: remapMessageProvider(result.message, "openai", "xai") } : {}),
  ...(result.messages
    ? { messages: result.messages.map((message) => remapMessageProvider(message, "openai", "xai")) }
    : {})
});

class XAILanguageModel implements LanguageModel<XAILanguageModelOptions> {
  readonly provider = "xai";
  readonly capabilities: ModelCapabilities;

  constructor(
    readonly modelId: string,
    private readonly delegate: LanguageModel,
    private readonly defaultHeaders: Record<string, string>
  ) {
    this.capabilities = modelCapabilities(modelId);
  }

  async generate(input: ModelGenerateInput<XAILanguageModelOptions>): Promise<GenerateResult> {
    validateXAIInput(this.modelId, input);
    try {
      return remapGenerateResult(await this.delegate.generate(prepareTransportInput(input, this.defaultHeaders)));
    } catch (error) {
      return remapHTTPError(error);
    }
  }

  async stream(input: ModelGenerateInput<XAILanguageModelOptions>): Promise<AsyncIterable<StreamEvent>> {
    validateXAIInput(this.modelId, input);
    if (!this.delegate.stream) {
      throw new UnsupportedFeatureError('Provider "xai" transport does not support streaming.');
    }

    let stream: AsyncIterable<StreamEvent>;
    try {
      stream = await this.delegate.stream(prepareTransportInput(input, this.defaultHeaders));
    } catch (error) {
      return remapHTTPError(error);
    }

    return (async function* () {
      for await (const event of stream) {
        if (event.type === "provider-data" && event.provider === "openai") {
          yield { ...event, provider: "xai" } satisfies StreamEvent;
        } else {
          yield event;
        }
      }
    })();
  }
}

const extractSources = (value: unknown) => {
  const sources: GroundedGenerateResult["sources"] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.url === "string") {
      sources.push({
        title: typeof record.title === "string" ? record.title : undefined,
        url: record.url,
        snippet: typeof record.snippet === "string" ? record.snippet : undefined,
        providerMetadata: record
      });
    }
    for (const nested of Object.values(record)) {
      if (Array.isArray(nested)) nested.forEach(visit);
      else if (nested && typeof nested === "object") visit(nested);
    }
  };
  visit(value);
  return sources.filter(
    (source, index, all) => all.findIndex((candidate) => candidate.url === source.url) === index
  );
};

class XAIGroundedLanguageModel implements GroundedLanguageModel<XAILanguageModelOptions> {
  readonly provider = "xai";
  readonly capabilities: ModelCapabilities;

  constructor(readonly modelId: string, private readonly languageModel: XAILanguageModel) {
    this.capabilities = languageModel.capabilities;
  }

  async generate(input: Parameters<GroundedLanguageModel<XAILanguageModelOptions>["generate"]>[0]) {
    const result = await this.languageModel.generate({
      ...input,
      messages: normalizeMessages(input),
      tools: { webSearch: xAIWebSearchTool() }
    });
    return {
      text: result.text ?? "",
      sources: extractSources(result.rawResponse),
      finishReason: result.finishReason,
      providerFinishReason: result.providerFinishReason,
      usage: result.usage,
      rawResponse: result.rawResponse
    };
  }
}

const blobFromData = (data: FileUploadInput["data"], mediaType: string) => {
  if (data instanceof Blob) return data;
  if (typeof data === "string") return new Blob([Buffer.from(data, "base64")], { type: mediaType });
  return new Blob([data instanceof Uint8Array ? (data.buffer as ArrayBuffer) : data], { type: mediaType });
};

const normalizeUploadedFile = (json: any): UploadedFile => ({
  name: json.id ?? json.name,
  uri: json.id ?? json.uri,
  mimeType: json.mime_type ?? json.mimeType,
  sizeBytes: json.bytes ?? json.size_bytes ?? json.sizeBytes,
  state: json.status ?? json.state,
  displayName: json.filename ?? json.display_name ?? json.displayName,
  rawResponse: json,
  providerMetadata: json
});

const appendQuery = (url: string, query: Record<string, string | number | undefined>) => {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) parsed.searchParams.set(key, String(value));
  }
  return parsed.toString();
};

class XAIFilesClient implements FilesClient<XAIFileOptions> {
  constructor(
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async upload(input: FileUploadInput<XAIFileOptions>): Promise<UploadedFile> {
    const { signal, cleanup } = withTimeoutSignal(input);
    const form = new FormData();
    const options = input.providerOptions ?? {};
    if (
      options.expires_after !== undefined &&
      (!Number.isInteger(options.expires_after) || options.expires_after < 3_600 || options.expires_after > 2_592_000)
    ) {
      throw new UnsupportedFeatureError(
        'Provider "xai" requires files.expires_after to be an integer between 3600 and 2592000 seconds.'
      );
    }
    if (options.expires_after !== undefined) form.set("expires_after", String(options.expires_after));
    form.set("purpose", options.purpose ?? "assistants");
    for (const [key, value] of Object.entries(options)) {
      if (!["expires_after", "purpose", "order", "sort_by", "filter"].includes(key) && value !== undefined) {
        form.set(key, typeof value === "string" ? value : JSON.stringify(value));
      }
    }
    const filename = input.filename ?? input.displayName ?? input.name ?? "file";
    form.set("file", blobFromData(input.data, input.mediaType), filename);

    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/files`, {
            method: "POST",
            headers: { authorization: `Bearer ${this.apiKey}` },
            signal,
            body: form
          }),
        input
      );
      return normalizeUploadedFile(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async get(input: FileGetInput<XAIFileOptions>): Promise<UploadedFile> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/files/${input.name}`, {
            method: "GET",
            headers: jsonHeaders(this.apiKey),
            signal
          }),
        input
      );
      return normalizeUploadedFile(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async list(input: FileListInput<XAIFileOptions> = {}) {
    const { signal, cleanup } = withTimeoutSignal(input);
    const options = input.providerOptions ?? {};
    try {
      const response = await withRetry(
        () =>
          this.fetcher(
            appendQuery(`${this.baseURL}/files`, {
              limit: input.pageSize,
              pagination_token: input.pageToken,
              order: options.order,
              sort_by: options.sort_by,
              filter: options.filter
            }),
            { method: "GET", headers: jsonHeaders(this.apiKey), signal }
          ),
        input
      );
      const json = await parseJson(response);
      return {
        files: (json.data ?? json.files ?? []).map(normalizeUploadedFile),
        nextPageToken: json.pagination_token ?? json.next ?? json.nextPageToken,
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }

  async delete(input: FileDeleteInput<XAIFileOptions>) {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/files/${input.name}`, {
            method: "DELETE",
            headers: jsonHeaders(this.apiKey),
            signal
          }),
        input
      );
      return { name: input.name, rawResponse: await parseJson(response) };
    } finally {
      cleanup();
    }
  }
}

const sanitizeConfig = (config: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined)) as Record<string, JsonValue>;

export const xAIWebSearchTool = (config: XAIWebSearchToolConfig = {}) => {
  const { allowed_domains, excluded_domains, ...rest } = config;
  if (allowed_domains?.length && excluded_domains?.length) {
    throw new UnsupportedFeatureError(
      'Provider "xai" Web Search cannot combine allowed_domains with excluded_domains.'
    );
  }
  return hostedTool({
    name: "web_search",
    provider: "xai",
    type: "web_search",
    toolClass: "web-search",
    config: sanitizeConfig({
      ...rest,
      ...(allowed_domains?.length ? { filters: { allowed_domains } } : {}),
      ...(excluded_domains?.length ? { filters: { excluded_domains } } : {})
    })
  });
};

export const xAIXSearchTool = (config: XAIXSearchToolConfig = {}) =>
  hostedTool({
    name: "x_search",
    provider: "xai",
    type: "x_search",
    toolClass: "web-search",
    config: sanitizeConfig(config as unknown as Record<string, unknown>)
  });

export const xAICodeExecutionTool = (config: XAICodeExecutionToolConfig = {}) =>
  hostedTool({
    name: "code_execution",
    provider: "xai",
    type: "code_interpreter",
    toolClass: "code-execution",
    config: sanitizeConfig(config as unknown as Record<string, unknown>)
  });

export const xAIFileSearchTool = (config: XAIFileSearchToolConfig) =>
  hostedTool({
    name: "file_search",
    provider: "xai",
    type: "file_search",
    toolClass: "file-search",
    config: sanitizeConfig(config as unknown as Record<string, unknown>)
  });

export const xAIFilePart = (fileId: string, mediaType = "application/octet-stream", filename?: string) => ({
  type: "file" as const,
  data: fileId,
  mediaType,
  filename
});

export const createXAI = (
  options: XAIProviderOptions = {}
): CallableProviderAdapter &
  ProviderAdapter & {
    files: FilesClient<XAIFileOptions>;
    rawFetch: typeof globalThis.fetch;
  } => {
  const apiKey = options.apiKey ?? process.env.XAI_API_KEY;
  if (!apiKey) throw new ConfigurationError("Missing xAI API key.");

  const baseURL = (options.baseURL ?? "https://api.x.ai/v1").replace(/\/+$/, "");
  const fetcher = options.fetch ?? globalThis.fetch;
  const transport = createOpenAI({ apiKey, baseURL, fetch: fetcher });
  const defaultHeaders = options.headers ?? {};
  const languageModel = (modelId: string) =>
    new XAILanguageModel(modelId, transport.languageModel(modelId), defaultHeaders);

  return createProviderAdapter({
    name: "xai",
    languageModel,
    groundedLanguageModel: (modelId) => new XAIGroundedLanguageModel(modelId, languageModel(modelId)),
    files: new XAIFilesClient(apiKey, baseURL, fetcher),
    rawFetch: fetcher
  });
};
