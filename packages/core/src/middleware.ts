import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  CircuitBreakerState,
  FinishReason,
  GenerateResult,
  LanguageModel,
  LanguageModelMiddleware,
  LanguageModelTelemetryEvent,
  ModelGenerateInput,
  ProviderOptions,
  StreamEvent
} from "./types.js";

const serializeInput = (input: unknown) => JSON.stringify(input);

export interface GenerateCache {
  get(key: string): Promise<GenerateResult | undefined> | GenerateResult | undefined;
  set(key: string, value: GenerateResult): Promise<void> | void;
}

export const wrapLanguageModel = <TProviderOptions extends ProviderOptions>(
  model: LanguageModel<TProviderOptions>,
  middlewares: Array<LanguageModelMiddleware<TProviderOptions>>
): LanguageModel<TProviderOptions> => {
  if (!middlewares.length) {
    return model;
  }

  const runGenerate = async (input: ModelGenerateInput<TProviderOptions>): Promise<GenerateResult> => {
    let index = -1;

    const run = async (position: number): Promise<GenerateResult> => {
      if (position <= index) {
        throw new Error("Language model middleware called next() multiple times.");
      }

      index = position;
      const middleware = middlewares[position];
      if (!middleware?.wrapGenerate) {
        return position >= middlewares.length ? model.generate(input) : run(position + 1);
      }

      return middleware.wrapGenerate({ model, input }, () => run(position + 1));
    };

    return run(0);
  };

  const runStream = async (input: ModelGenerateInput<TProviderOptions>): Promise<AsyncIterable<StreamEvent>> => {
    if (!model.stream) {
      throw new Error(`Language model "${model.provider}/${model.modelId}" does not support streaming.`);
    }

    let index = -1;

    const run = async (position: number): Promise<AsyncIterable<StreamEvent>> => {
      if (position <= index) {
        throw new Error("Language model middleware called next() multiple times.");
      }

      index = position;
      const middleware = middlewares[position];
      if (!middleware?.wrapStream) {
        return position >= middlewares.length ? model.stream!(input) : run(position + 1);
      }

      return middleware.wrapStream({ model, input }, () => run(position + 1));
    };

    return run(0);
  };

  return {
    ...model,
    generate(input: ModelGenerateInput<TProviderOptions>): Promise<GenerateResult> {
      return runGenerate(input);
    },
    stream: model.stream
      ? (input: ModelGenerateInput<TProviderOptions>) => runStream(input)
      : undefined
  };
};

export const createTelemetryMiddleware = <TProviderOptions extends ProviderOptions>(options: {
  onEvent: (event: LanguageModelTelemetryEvent<TProviderOptions>) => void | Promise<void>;
}): LanguageModelMiddleware<TProviderOptions> => ({
  name: "telemetry",
  async wrapGenerate(context, next) {
    const startedAt = Date.now();
    await options.onEvent({
      type: "generate-start",
      model: context.model,
      input: context.input,
      startedAt
    });

    try {
      const output = await next();
      const finishedAt = Date.now();
      await options.onEvent({
        type: "generate-finish",
        model: context.model,
        input: context.input,
        output,
        startedAt,
        finishedAt,
        latencyMs: finishedAt - startedAt
      });
      return output;
    } catch (error) {
      const finishedAt = Date.now();
      const err = error instanceof Error ? error : new Error(String(error));
      await options.onEvent({
        type: "generate-error",
        model: context.model,
        input: context.input,
        error: err,
        startedAt,
        finishedAt,
        latencyMs: finishedAt - startedAt
      });
      throw error;
    }
  },
  async wrapStream(context, next) {
    const startedAt = Date.now();
    await options.onEvent({
      type: "stream-start",
      model: context.model,
      input: context.input,
      startedAt
    });

    try {
      const stream = await next();

      return (async function* () {
        let finishReason: FinishReason | undefined;
        let providerFinishReason: string | undefined;
        let usage: Extract<StreamEvent, { type: "finish" }>["usage"];

        try {
          for await (const event of stream) {
            if (event.type === "finish") {
              finishReason = event.finishReason;
              providerFinishReason = event.providerFinishReason;
              usage = event.usage;
            }

            yield event;
          }

          const finishedAt = Date.now();
          await options.onEvent({
            type: "stream-finish",
            model: context.model,
            input: context.input,
            startedAt,
            finishedAt,
            latencyMs: finishedAt - startedAt,
            finishReason,
            providerFinishReason,
            usage
          });
        } catch (error) {
          const finishedAt = Date.now();
          const err = error instanceof Error ? error : new Error(String(error));
          await options.onEvent({
            type: "stream-error",
            model: context.model,
            input: context.input,
            error: err,
            startedAt,
            finishedAt,
            latencyMs: finishedAt - startedAt
          });
          throw error;
        }
      })();
    } catch (error) {
      const finishedAt = Date.now();
      const err = error instanceof Error ? error : new Error(String(error));
      await options.onEvent({
        type: "stream-error",
        model: context.model,
        input: context.input,
        error: err,
        startedAt,
        finishedAt,
        latencyMs: finishedAt - startedAt
      });
      throw error;
    }
  }
});

export const createCachedGenerateMiddleware = <TProviderOptions extends ProviderOptions>(options: {
  cache: GenerateCache;
  getKey?: (input: ModelGenerateInput<TProviderOptions>, model: LanguageModel<TProviderOptions>) => string;
}): LanguageModelMiddleware<TProviderOptions> => ({
  name: "cache",
  async wrapGenerate(context, next) {
    const key =
      options.getKey?.(context.input, context.model) ??
      serializeInput({
        provider: context.model.provider,
        modelId: context.model.modelId,
        input: context.input
      });

    const cached = await options.cache.get(key);
    if (cached) {
      return cached;
    }

    const output = await next();
    await options.cache.set(key, output);
    return output;
  }
});

export const createInMemoryGenerateCache = (): GenerateCache => {
  const store = new Map<string, GenerateResult>();

  return {
    get(key) {
      return store.get(key);
    },
    set(key, value) {
      store.set(key, value);
    }
  };
};

export const createFileGenerateCache = (options: { dir: string }): GenerateCache => {
  const getPath = (key: string) => path.join(options.dir, `${Buffer.from(key).toString("base64url")}.json`);

  return {
    async get(key) {
      try {
        const file = await fs.readFile(getPath(key), "utf8");
        return JSON.parse(file) as GenerateResult;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err?.code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    },
    async set(key, value) {
      await fs.mkdir(options.dir, { recursive: true });
      await fs.writeFile(getPath(key), JSON.stringify(value), "utf8");
    }
  };
};

export const createCircuitBreakerMiddleware = <TProviderOptions extends ProviderOptions>(options: {
  failureThreshold?: number;
  cooldownMs?: number;
  isFailure?: (error: Error) => boolean;
  onStateChange?: (state: CircuitBreakerState & { model: LanguageModel<TProviderOptions>; status: "open" | "half-open" | "closed" }) => void | Promise<void>;
}): LanguageModelMiddleware<TProviderOptions> => {
  const failureThreshold = Math.max(1, options.failureThreshold ?? 3);
  const cooldownMs = Math.max(0, options.cooldownMs ?? 30_000);
  const state: CircuitBreakerState = { failures: 0 };

  return {
    name: "circuit-breaker",
    async wrapGenerate(context, next) {
      const now = Date.now();
      if (state.openedAt && now - state.openedAt < cooldownMs) {
        throw new Error(`Circuit breaker open for model "${context.model.provider}/${context.model.modelId}".`);
      }

      if (state.openedAt && now - state.openedAt >= cooldownMs) {
        await options.onStateChange?.({
          ...state,
          model: context.model,
          status: "half-open"
        });
      }

      try {
        const result = await next();
        state.failures = 0;
        state.openedAt = undefined;
        await options.onStateChange?.({
          ...state,
          model: context.model,
          status: "closed"
        });
        return result;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        const isFailure = options.isFailure?.(err) ?? true;
        if (!isFailure) {
          throw error;
        }

        state.failures += 1;
        if (state.failures >= failureThreshold) {
          state.openedAt = Date.now();
          await options.onStateChange?.({
            ...state,
            model: context.model,
            status: "open"
          });
        }

        throw error;
      }
    }
  };
};
