import {
  ConfigurationError,
  ProviderHTTPError,
  ValidationError,
  normalizeFinishReason,
  streamSSE,
  withRetry,
  withTimeoutSignal,
  type FinishReason,
  type RetryOptions,
  type TokenUsage
} from "@zhivex-ai/core";

export interface DeepSeekClientsOptions {
  apiKey?: string;
  baseURL?: string;
  betaBaseURL?: string;
  fetch?: typeof globalThis.fetch;
}

export type DeepSeekFIMModel = "deepseek-v4-pro";

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
}

const jsonHeaders = (apiKey: string) => ({
  "content-type": "application/json",
  authorization: `Bearer ${apiKey}`
});

const trimURL = (value: string) => value.replace(/\/+$/, "");

const assertResponseOk = async (response: Response, operation: string) => {
  if (response.ok) {
    return;
  }

  const responseBody = await response.text();
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
    return response.json();
  }, retryOptions);

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
  if (input.model !== undefined && input.model !== "deepseek-v4-pro") {
    throw new ValidationError('DeepSeek FIM currently supports only model "deepseek-v4-pro".');
  }
  if (
    input.maxTokens !== undefined &&
    (!Number.isInteger(input.maxTokens) || input.maxTokens < 1 || input.maxTokens > 4096)
  ) {
    throw new ValidationError('DeepSeek FIM "maxTokens" must be an integer between 1 and 4096.');
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
              yield {
                type: "text-delta",
                textDelta: choice.text,
                index: Number(choice.index ?? 0)
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

  const configuredBaseURL = trimURL(options.baseURL ?? "https://api.deepseek.com");
  const baseURL = configuredBaseURL.replace(/\/beta$/, "");
  const betaBaseURL = trimURL(
    options.betaBaseURL ?? (configuredBaseURL.endsWith("/beta") ? configuredBaseURL : `${configuredBaseURL}/beta`)
  );
  const fetcher = options.fetch ?? globalThis.fetch;

  return {
    fim: new DeepSeekFIMClientImpl(apiKey, betaBaseURL, fetcher),
    models: new DeepSeekModelsClientImpl(apiKey, baseURL, fetcher),
    balance: new DeepSeekBalanceClientImpl(apiKey, baseURL, fetcher)
  };
};
