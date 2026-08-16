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
const telemetryObserversSymbol = Symbol("zhivex-ai.telemetry-observers");

type TelemetryObserver<TProviderOptions extends ProviderOptions = ProviderOptions> = (
  event: LanguageModelTelemetryEvent<TProviderOptions>
) => void | Promise<void>;

type LanguageModelWithTelemetry<TProviderOptions extends ProviderOptions = ProviderOptions> = LanguageModel<TProviderOptions> & {
  [telemetryObserversSymbol]?: TelemetryObserver<TProviderOptions>[];
};

export interface GenerateCache {
  get(key: string): Promise<GenerateResult | undefined> | GenerateResult | undefined;
  set(key: string, value: GenerateResult): Promise<void> | void;
}

const getTelemetryObservers = <TProviderOptions extends ProviderOptions>(
  model: LanguageModel<TProviderOptions>
): TelemetryObserver<TProviderOptions>[] =>
  [...(((model as LanguageModelWithTelemetry<TProviderOptions>)[telemetryObserversSymbol] ?? []) as TelemetryObserver<TProviderOptions>[])];

export const emitLanguageModelTelemetryEvent = async <TProviderOptions extends ProviderOptions>(
  model: LanguageModel<TProviderOptions>,
  event: LanguageModelTelemetryEvent<TProviderOptions>
) => {
  const observers = getTelemetryObservers(model);
  for (const observer of observers) {
    await observer(event);
  }
};

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

  const wrappedModel: LanguageModelWithTelemetry<TProviderOptions> = {
    ...model,
    generate(input: ModelGenerateInput<TProviderOptions>): Promise<GenerateResult> {
      return runGenerate(input);
    },
    stream: model.stream
      ? (input: ModelGenerateInput<TProviderOptions>) => runStream(input)
      : undefined
  };

  const telemetryObservers = [
    ...getTelemetryObservers(model),
    ...middlewares
      .filter((middleware) => middleware.name === "telemetry")
      .map((middleware) => (event: LanguageModelTelemetryEvent<TProviderOptions>) => {
        const telemetryMiddleware = middleware as LanguageModelMiddleware<TProviderOptions> & {
          onTelemetryEvent?: TelemetryObserver<TProviderOptions>;
        };
        return telemetryMiddleware.onTelemetryEvent?.(event);
      })
      .filter(Boolean)
  ];

  if (telemetryObservers.length) {
    Object.defineProperty(wrappedModel, telemetryObserversSymbol, {
      value: telemetryObservers,
      enumerable: false,
      configurable: false
    });
  }

  return wrappedModel;
};

export const createTelemetryMiddleware = <TProviderOptions extends ProviderOptions>(options: {
  onEvent: (event: LanguageModelTelemetryEvent<TProviderOptions>) => void | Promise<void>;
}): LanguageModelMiddleware<TProviderOptions> => {
  let nextGenerateId = 1;
  let nextStreamId = 1;
  const reportTelemetry = async (event: LanguageModelTelemetryEvent<TProviderOptions>) => {
    try {
      await options.onEvent(event);
    } catch {
      // Telemetry is best-effort and never owns the model operation outcome.
    }
  };
  const middleware: LanguageModelMiddleware<TProviderOptions> & {
    onTelemetryEvent?: TelemetryObserver<TProviderOptions>;
  } = {
    name: "telemetry",
    onTelemetryEvent: reportTelemetry,
    async wrapGenerate(context, next) {
    const generateId = nextGenerateId;
    nextGenerateId += 1;
    const startedAt = Date.now();
    await reportTelemetry({
      type: "generate-start",
      generateId,
      model: context.model,
      input: context.input,
      startedAt
    });

    try {
      const output = await next();
      const finishedAt = Date.now();
      await reportTelemetry({
        type: "generate-finish",
        generateId,
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
      await reportTelemetry({
        type: "generate-error",
        generateId,
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
    const streamId = nextStreamId;
    nextStreamId += 1;

    return (async function* () {
        const operationStartedAt = Date.now();
        let finishReason: FinishReason | undefined;
        let providerFinishReason: string | undefined;
        let usage: Extract<StreamEvent, { type: "finish" }>["usage"];
        let firstChunkAt: number | undefined;
        let previousChunkAt: number | undefined;
        let outputChunkCount = 0;
        let terminalEventEmitted = false;

        try {
          await reportTelemetry({
            type: "stream-start",
            streamId,
            model: context.model,
            input: context.input,
            startedAt: operationStartedAt
          });
          const stream = await next();
          for await (const event of stream) {
            if (event.type === "finish") {
              finishReason = event.finishReason;
              providerFinishReason = event.providerFinishReason;
              usage = event.usage;
              const finishedAt = Date.now();
              terminalEventEmitted = true;
              await reportTelemetry({
                type: "stream-finish",
                streamId,
                model: context.model,
                input: context.input,
                startedAt: operationStartedAt,
                finishedAt,
                latencyMs: finishedAt - operationStartedAt,
                finishReason,
                providerFinishReason,
                usage,
                outputChunkCount
              });
            } else if (event.type === "error") {
              const finishedAt = Date.now();
              terminalEventEmitted = true;
              await reportTelemetry({
                type: "stream-error",
                streamId,
                model: context.model,
                input: context.input,
                error: event.error,
                startedAt: operationStartedAt,
                finishedAt,
                latencyMs: finishedAt - operationStartedAt,
                outputChunkCount
              });
            } else {
              const chunkAt = Date.now();
              firstChunkAt ??= chunkAt;
              const timeSincePreviousChunkMs = previousChunkAt === undefined
                ? undefined
                : chunkAt - previousChunkAt;
              previousChunkAt = chunkAt;
              outputChunkCount += 1;
              await reportTelemetry({
                type: "stream-chunk",
                streamId,
                model: context.model,
                input: context.input,
                startedAt: operationStartedAt,
                chunkAt,
                chunkIndex: outputChunkCount,
                timeToFirstChunkMs: outputChunkCount === 1 ? chunkAt - operationStartedAt : undefined,
                timeSincePreviousChunkMs
              });
            }

            yield event;
            if (terminalEventEmitted) return;
          }

          if (!terminalEventEmitted) {
            const finishedAt = Date.now();
            terminalEventEmitted = true;
            await reportTelemetry({
              type: "stream-finish",
              streamId,
              model: context.model,
              input: context.input,
              startedAt: operationStartedAt,
              finishedAt,
              latencyMs: finishedAt - operationStartedAt,
              finishReason,
              providerFinishReason,
              usage,
              outputChunkCount
            });
          }
        } catch (error) {
          const finishedAt = Date.now();
          const err = error instanceof Error ? error : new Error(String(error));
          if (!terminalEventEmitted) {
            terminalEventEmitted = true;
            await reportTelemetry({
              type: "stream-error",
              streamId,
              model: context.model,
              input: context.input,
              error: err,
              startedAt: operationStartedAt,
              finishedAt,
              latencyMs: finishedAt - operationStartedAt,
              outputChunkCount
            });
          }
          throw error;
        } finally {
          if (!terminalEventEmitted) {
            terminalEventEmitted = true;
            const finishedAt = Date.now();
            const error = Object.assign(
              new Error("Stream consumption ended before the provider stream completed."),
              { name: "AbortError" }
            );
            await reportTelemetry({
              type: "stream-error",
              streamId,
              model: context.model,
              input: context.input,
              error,
              startedAt: operationStartedAt,
              finishedAt,
              latencyMs: finishedAt - operationStartedAt,
              outputChunkCount
            });
          }
        }
      })();
  }
  };

  return middleware;
};

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
