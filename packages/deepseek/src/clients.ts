import {
  ConfigurationError,
  ProviderHTTPError,
  ValidationError,
  assertTrustedEndpoint,
  normalizeFinishReason,
  readErrorBodyWithLimit,
  readJsonWithLimit,
  streamSSE,
  withRetry,
  withTimeoutSignal,
  type FinishReason,
  type FileDeleteInput,
  type FileGetInput,
  type FileListInput,
  type FileUploadInput,
  type FilesClient,
  type RetryOptions,
  type TokenUsage,
  type UploadedFile
} from "@zhivex-ai/core";

export interface DeepSeekClientsOptions {
  apiKey?: string;
  baseURL?: string;
  betaBaseURL?: string;
  fetch?: typeof globalThis.fetch;
  allowUnsafeEndpoints?: boolean;
}

export type DeepSeekFIMModel = "deepseek-v4-flash" | "deepseek-v4-pro";

export interface DeepSeekFIMInput extends RetryOptions {
  prompt: string;
  model?: DeepSeekFIMModel;
  suffix?: string;
  echo?: boolean;
  logprobs?: number;
  maxTokens?: number;
  stop?: string | string[];
  temperature?: number;
  topP?: number;
}

export interface DeepSeekFIMLogprobs {
  textOffset?: number[];
  tokenLogprobs?: Array<number | null>;
  tokens?: string[];
  topLogprobs?: Array<Record<string, number>>;
}

export interface DeepSeekFIMChoice {
  index: number;
  text: string;
  finishReason?: string;
  logprobs?: DeepSeekFIMLogprobs;
}

export interface DeepSeekFIMResult {
  text: string;
  choices: DeepSeekFIMChoice[];
  finishReason?: FinishReason;
  providerFinishReason?: string;
  usage?: TokenUsage;
  rawResponse: unknown;
}

export type DeepSeekFIMStreamEvent =
  | {
      type: "text-delta";
      textDelta: string;
      index: number;
      logprobs?: DeepSeekFIMLogprobs;
    }
  | {
      type: "finish";
      finishReason?: FinishReason;
      providerFinishReason?: string;
      usage?: TokenUsage;
    };

export interface DeepSeekModel {
  id: string;
  object: string;
  ownedBy: string;
}

export interface DeepSeekModelList {
  models: DeepSeekModel[];
  rawResponse: unknown;
}

export interface DeepSeekBalanceInfo {
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
}

export interface DeepSeekBalance {
  isAvailable: boolean;
  balances: DeepSeekBalanceInfo[];
  rawResponse: unknown;
}

export interface DeepSeekFIMClient {
  generate(input: DeepSeekFIMInput): Promise<DeepSeekFIMResult>;
  stream(input: DeepSeekFIMInput): Promise<AsyncIterable<DeepSeekFIMStreamEvent>>;
}

export interface DeepSeekModelsClient {
  list(input?: RetryOptions): Promise<DeepSeekModelList>;
}

export interface DeepSeekBalanceClient {
  get(input?: RetryOptions): Promise<DeepSeekBalance>;
}

export interface DeepSeekClients {
  fim: DeepSeekFIMClient;
  models: DeepSeekModelsClient;
  balance: DeepSeekBalanceClient;
  files: FilesClient;
}

const jsonHeaders = (apiKey: string) => ({
  "content-type": "application/json",
  authorization: `Bearer ${apiKey}`
});

const trimURL = (value: string) => value.replace(/\/+$/, "");

const appendQuery = (url: string, query: Record<string, string | number | undefined>) => {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      parsed.searchParams.set(key, String(value));
    }
  }
  return parsed.toString();
};

const DEEPSEEK_FILE_MAX_BYTES = 64 * 1024 * 1024;
const DEEPSEEK_FILE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp"
]);

const deepSeekFileId = (value: string) => {
  if (!/^file-api-[A-Za-z0-9._-]+$/.test(value)) {
    throw new ValidationError(
      'DeepSeek file IDs must be opaque identifiers beginning with "file-api-".'
    );
  }
  return encodeURIComponent(value);
};

const fileDataBytes = async (data: FileUploadInput["data"]) => {
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return new Uint8Array(await data.arrayBuffer());
};

const normalizeDeepSeekFile = (json: any, fallbackMediaType?: string): UploadedFile => {
  const file = json.file ?? json;
  return {
    name: String(file.id ?? file.name ?? ""),
    mimeType: file.mime_type ?? file.mimeType ?? fallbackMediaType,
    sizeBytes: file.bytes ?? file.size_bytes ?? file.sizeBytes,
    state: file.status ?? file.state,
    displayName: file.filename ?? file.display_name ?? file.displayName,
    rawResponse: json,
    providerMetadata: file
  };
};

const assertResponseOk = async (response: Response, operation: string) => {
  if (response.ok) {
    return;
  }

  const responseBody = await readErrorBodyWithLimit(response);
  throw new ProviderHTTPError(`DeepSeek ${operation} request failed with status ${response.status}.`, response.status, {
    responseBody
  });
};

const requestJson = async (
  fetcher: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  operation: string,
  retryOptions: RetryOptions
) =>
  withRetry(async () => {
    const response = await fetcher(url, init);
    await assertResponseOk(response, operation);
    return readJsonWithLimit<any>(response, {
      maxBytes: 128 * 1024 * 1024,
      provider: "deepseek",
      endpoint: operation
    });
  }, retryOptions);

class DeepSeekFilesClientImpl implements FilesClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async upload(input: FileUploadInput): Promise<UploadedFile> {
    const mediaType = input.mediaType.toLowerCase();
    if (!DEEPSEEK_FILE_MEDIA_TYPES.has(mediaType)) {
      throw new ValidationError("DeepSeek Vision file uploads support JPEG, PNG, GIF, and WebP images.");
    }
    const bytes = await fileDataBytes(input.data);
    if (bytes.byteLength > DEEPSEEK_FILE_MAX_BYTES) {
      throw new ValidationError("DeepSeek file uploads must not exceed 64 MiB.");
    }
    const expiresAfterSeconds = input.providerOptions?.expiresAfterSeconds;
    if (
      expiresAfterSeconds !== undefined &&
      (!Number.isSafeInteger(expiresAfterSeconds) ||
        Number(expiresAfterSeconds) < 3_600 ||
        Number(expiresAfterSeconds) > 2_592_000)
    ) {
      throw new ValidationError("DeepSeek file expiration must be an integer from 3,600 to 2,592,000 seconds.");
    }

    const form = new FormData();
    const filename = input.filename ?? input.displayName ?? input.name ?? "image";
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    form.set("file", new File([buffer], filename, { type: mediaType }));
    form.set("purpose", "user_data");
    if (expiresAfterSeconds !== undefined) {
      form.set("expires_after[anchor]", "created_at");
      form.set("expires_after[seconds]", String(expiresAfterSeconds));
    }

    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const json = await requestJson(
        this.fetcher,
        `${this.baseURL}/files`,
        {
          method: "POST",
          redirect: "error",
          headers: { authorization: `Bearer ${this.apiKey}` },
          signal,
          body: form
        },
        "file upload",
        input
      );
      return normalizeDeepSeekFile(json, mediaType);
    } finally {
      cleanup();
    }
  }

  async get(input: FileGetInput): Promise<UploadedFile> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const json = await requestJson(
        this.fetcher,
        `${this.baseURL}/files/${deepSeekFileId(input.name)}`,
        { method: "GET", headers: jsonHeaders(this.apiKey), signal },
        "file get",
        input
      );
      return normalizeDeepSeekFile(json);
    } finally {
      cleanup();
    }
  }

  async list(input: FileListInput = {}) {
    if (input.pageSize !== undefined && (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 1_000)) {
      throw new ValidationError("DeepSeek file list pageSize must be an integer from 1 to 1,000.");
    }
    if (input.pageToken !== undefined) {
      deepSeekFileId(input.pageToken);
    }
    const order = input.providerOptions?.order;
    if (order !== undefined && order !== "asc" && order !== "desc") {
      throw new ValidationError('DeepSeek file list order must be "asc" or "desc".');
    }
    const purpose = input.providerOptions?.purpose;
    if (purpose !== undefined && purpose !== "user_data") {
      throw new ValidationError('DeepSeek file list purpose must be "user_data".');
    }
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const json = await requestJson(
        this.fetcher,
        appendQuery(`${this.baseURL}/files`, {
          limit: input.pageSize,
          after: input.pageToken,
          order: order as string | undefined,
          purpose: purpose as string | undefined
        }),
        { method: "GET", headers: jsonHeaders(this.apiKey), signal },
        "file list",
        input
      );
      return {
        files: (json.data ?? json.files ?? []).map((file: unknown) => normalizeDeepSeekFile(file)),
        nextPageToken: json.has_more ? json.last_id : undefined,
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }

  async delete(input: FileDeleteInput) {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const json = await requestJson(
        this.fetcher,
        `${this.baseURL}/files/${deepSeekFileId(input.name)}`,
        { method: "DELETE", headers: jsonHeaders(this.apiKey), signal },
        "file delete",
        input
      );
      return { name: input.name, rawResponse: json };
    } finally {
      cleanup();
    }
  }
}

const normalizeUsage = (usage: any): TokenUsage | undefined =>
  usage
    ? {
        inputTokens: usage.prompt_tokens,
        cachedInputTokens: usage.prompt_cache_hit_tokens,
        outputTokens: usage.completion_tokens,
        reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
        totalTokens: usage.total_tokens
      }
    : undefined;

const normalizeFIMFinishReason = (reason: string | undefined): FinishReason | undefined =>
  reason === "insufficient_system_resource" ? "error" : normalizeFinishReason(reason);

const normalizeLogprobs = (logprobs: any): DeepSeekFIMLogprobs | undefined =>
  logprobs
    ? {
        textOffset: logprobs.text_offset,
        tokenLogprobs: logprobs.token_logprobs,
        tokens: logprobs.tokens,
        topLogprobs: logprobs.top_logprobs
      }
    : undefined;

const normalizeFIMChoice = (choice: any): DeepSeekFIMChoice => ({
  index: Number(choice.index ?? 0),
  text: typeof choice.text === "string" ? choice.text : "",
  finishReason: choice.finish_reason ?? undefined,
  logprobs: normalizeLogprobs(choice.logprobs)
});

const validateFIMInput = (input: DeepSeekFIMInput) => {
  if (!input || typeof input.prompt !== "string") {
    throw new ValidationError('DeepSeek FIM requires a string "prompt".');
  }
  if (
    input.model !== undefined &&
    input.model !== "deepseek-v4-flash" &&
    input.model !== "deepseek-v4-pro"
  ) {
    throw new ValidationError(
      'DeepSeek FIM "model" must be "deepseek-v4-flash" or "deepseek-v4-pro".'
    );
  }
  if (
    input.maxTokens !== undefined &&
    (!Number.isInteger(input.maxTokens) || input.maxTokens < 1)
  ) {
    throw new ValidationError('DeepSeek FIM "maxTokens" must be a positive integer.');
  }
  if (
    input.logprobs !== undefined &&
    (!Number.isInteger(input.logprobs) || input.logprobs < 0 || input.logprobs > 20)
  ) {
    throw new ValidationError('DeepSeek FIM "logprobs" must be an integer between 0 and 20.');
  }
  if (input.suffix !== undefined && typeof input.suffix !== "string") {
    throw new ValidationError('DeepSeek FIM "suffix" must be a string.');
  }
  if (input.echo !== undefined && typeof input.echo !== "boolean") {
    throw new ValidationError('DeepSeek FIM "echo" must be a boolean.');
  }
  if (
    input.stop !== undefined &&
    typeof input.stop !== "string" &&
    (!Array.isArray(input.stop) || input.stop.some((value) => typeof value !== "string"))
  ) {
    throw new ValidationError('DeepSeek FIM "stop" must be a string or an array of strings.');
  }
  if (Array.isArray(input.stop) && input.stop.length > 16) {
    throw new ValidationError('DeepSeek FIM "stop" accepts at most 16 sequences.');
  }
  if (
    input.temperature !== undefined &&
    (typeof input.temperature !== "number" ||
      !Number.isFinite(input.temperature) ||
      input.temperature < 0 ||
      input.temperature > 2)
  ) {
    throw new ValidationError('DeepSeek FIM "temperature" must be between 0 and 2.');
  }
  if (
    input.topP !== undefined &&
    (typeof input.topP !== "number" || !Number.isFinite(input.topP) || input.topP < 0 || input.topP > 1)
  ) {
    throw new ValidationError('DeepSeek FIM "topP" must be between 0 and 1.');
  }
};

const fimBody = (input: DeepSeekFIMInput, stream: boolean) => ({
  model: input.model ?? "deepseek-v4-pro",
  prompt: input.prompt,
  suffix: input.suffix,
  echo: input.echo,
  logprobs: input.logprobs,
  max_tokens: input.maxTokens,
  stop: input.stop,
  temperature: input.temperature,
  top_p: input.topP,
  stream,
  ...(stream ? { stream_options: { include_usage: true } } : {})
});

class DeepSeekFIMClientImpl implements DeepSeekFIMClient {
  constructor(
    private readonly apiKey: string,
    private readonly betaBaseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async generate(input: DeepSeekFIMInput): Promise<DeepSeekFIMResult> {
    validateFIMInput(input);
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      const json = await requestJson(
        this.fetcher,
        `${this.betaBaseURL}/completions`,
        {
          method: "POST",
          headers: jsonHeaders(this.apiKey),
          signal,
          body: JSON.stringify(fimBody(input, false))
        },
        "FIM",
        input
      );
      const choices = (json.choices ?? []).map(normalizeFIMChoice);
      const providerFinishReason = choices[0]?.finishReason;

      return {
        text: choices[0]?.text ?? "",
        choices,
        finishReason: normalizeFIMFinishReason(providerFinishReason),
        providerFinishReason,
        usage: normalizeUsage(json.usage),
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }

  async stream(input: DeepSeekFIMInput): Promise<AsyncIterable<DeepSeekFIMStreamEvent>> {
    validateFIMInput(input);
    const { signal, cleanup } = withTimeoutSignal(input);
    let response: Response;

    try {
      response = await withRetry(async () => {
        const result = await this.fetcher(`${this.betaBaseURL}/completions`, {
          method: "POST",
          headers: jsonHeaders(this.apiKey),
          signal,
          body: JSON.stringify(fimBody(input, true))
        });
        await assertResponseOk(result, "FIM");
        return result;
      }, input);
    } catch (error) {
      cleanup();
      throw error;
    }

    return (async function* () {
      let providerFinishReason: string | undefined;
      let usage: TokenUsage | undefined;
      let finishEmitted = false;

      const finish = (): DeepSeekFIMStreamEvent => ({
        type: "finish",
        finishReason: normalizeFIMFinishReason(providerFinishReason),
        providerFinishReason,
        usage
      });

      try {
        for await (const event of streamSSE(response)) {
          if (event.data === "[DONE]") {
            if (!finishEmitted && (providerFinishReason !== undefined || usage !== undefined)) {
              finishEmitted = true;
              yield finish();
            }
            return;
          }

          const json = JSON.parse(event.data);
          const choices = Array.isArray(json.choices) ? json.choices : [];
          usage = normalizeUsage(json.usage) ?? usage;

          for (const choice of choices) {
            if (typeof choice.text === "string" && choice.text) {
              const logprobs = normalizeLogprobs(choice.logprobs);
              yield {
                type: "text-delta",
                textDelta: choice.text,
                index: Number(choice.index ?? 0),
                ...(logprobs ? { logprobs } : {})
              } satisfies DeepSeekFIMStreamEvent;
            }
            if (choice.finish_reason) {
              providerFinishReason = choice.finish_reason;
            }
          }

          if (!finishEmitted && usage !== undefined && (choices.length === 0 || providerFinishReason !== undefined)) {
            finishEmitted = true;
            yield finish();
          }
        }

        if (!finishEmitted && (providerFinishReason !== undefined || usage !== undefined)) {
          yield finish();
        }
      } finally {
        cleanup();
      }
    })();
  }
}

class DeepSeekModelsClientImpl implements DeepSeekModelsClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async list(input: RetryOptions = {}): Promise<DeepSeekModelList> {
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      const json = await requestJson(
        this.fetcher,
        `${this.baseURL}/models`,
        { method: "GET", headers: jsonHeaders(this.apiKey), signal },
        "models",
        input
      );

      return {
        models: (json.data ?? []).map((model: any) => ({
          id: String(model.id),
          object: String(model.object ?? "model"),
          ownedBy: String(model.owned_by ?? "")
        })),
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }
}

class DeepSeekBalanceClientImpl implements DeepSeekBalanceClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async get(input: RetryOptions = {}): Promise<DeepSeekBalance> {
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      const json = await requestJson(
        this.fetcher,
        `${this.baseURL}/user/balance`,
        { method: "GET", headers: jsonHeaders(this.apiKey), signal },
        "balance",
        input
      );

      return {
        isAvailable: Boolean(json.is_available),
        balances: (json.balance_infos ?? []).map((balance: any) => ({
          currency: String(balance.currency),
          totalBalance: String(balance.total_balance),
          grantedBalance: String(balance.granted_balance),
          toppedUpBalance: String(balance.topped_up_balance)
        })),
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }
}

export const createDeepSeekClients = (options: DeepSeekClientsOptions = {}): DeepSeekClients => {
  const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new ConfigurationError("Missing DeepSeek API key.");
  }

  const configuredBaseURL = trimURL(
    assertTrustedEndpoint(options.baseURL ?? "https://api.deepseek.com", {
      label: "DeepSeek clients baseURL",
      protocols: ["https"],
      allowUnsafe: options.allowUnsafeEndpoints
    }).toString()
  );
  const baseURL = configuredBaseURL.replace(/\/beta$/, "");
  const betaBaseURL = trimURL(
    assertTrustedEndpoint(
      options.betaBaseURL ?? (configuredBaseURL.endsWith("/beta") ? configuredBaseURL : `${configuredBaseURL}/beta`),
      {
        label: "DeepSeek clients betaBaseURL",
        protocols: ["https"],
        allowUnsafe: options.allowUnsafeEndpoints
      }
    ).toString()
  );
  const fetcher = options.fetch ?? globalThis.fetch;

  return {
    fim: new DeepSeekFIMClientImpl(apiKey, betaBaseURL, fetcher),
    models: new DeepSeekModelsClientImpl(apiKey, baseURL, fetcher),
    balance: new DeepSeekBalanceClientImpl(apiKey, baseURL, fetcher),
    files: new DeepSeekFilesClientImpl(apiKey, baseURL, fetcher)
  };
};
