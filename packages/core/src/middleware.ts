import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";

import { ValidationError } from "./errors.js";
import {
  canonicalStoreFileStem,
  ensurePrivateDirectory,
  writePrivateFile
} from "./store-security.js";
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

const cacheKeySensitiveField = /(?:^|[-_])(api[-_]?key|authorization|cookie|credential|password|secret|token)(?:$|[-_])/iu;
const cacheKeyOmittedFields = new Set([
  "abortSignal",
  "execute",
  "inputGuardrails",
  "isEnabled",
  "onError",
  "outputGuardrails",
  "signal"
]);

const canonicalCacheInput = (value: unknown, seen = new WeakSet<object>()): string => {
  if (value === null) return "null";
  if (value === undefined) return '"[undefined]"';
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (Number.isNaN(value)) return '"[number:NaN]"';
    if (value === Number.POSITIVE_INFINITY) return '"[number:Infinity]"';
    if (value === Number.NEGATIVE_INFINITY) return '"[number:-Infinity]"';
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === "bigint") return JSON.stringify(`[bigint:${value.toString()}]`);
  if (typeof value === "function" || typeof value === "symbol") {
    throw new TypeError("Generate cache keys cannot canonicalize functions or symbols.");
  }

  if (value instanceof Date) return JSON.stringify(`[date:${value.toISOString()}]`);
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return JSON.stringify(`[bytes:sha256:${createHash("sha256").update(bytes).digest("hex")}]`);
  }
  if (typeof AbortSignal !== "undefined" && value instanceof AbortSignal) {
    return '"[abort-signal]"';
  }
  if (seen.has(value)) {
    throw new TypeError("Generate cache keys cannot canonicalize cyclic input.");
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalCacheInput(entry, seen)).join(",")}]`;
    }

    return `{${Object.keys(value)
      .filter((key) => !cacheKeyOmittedFields.has(key))
      .sort()
      .map((key) => {
        if (cacheKeySensitiveField.test(key)) {
          throw new TypeError("Generate cache keys cannot include sensitive fields.");
        }
        const entry = (value as Record<string, unknown>)[key];
        const serialized = canonicalCacheInput(entry, seen);
        return `${JSON.stringify(key)}:${serialized}`;
      })
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
};

const createDefaultGenerateCacheKey = (input: unknown): string =>
  `generate:v2:${createHash("sha256").update(canonicalCacheInput(input)).digest("hex")}`;
const defaultGenerateCacheModelScopes = new WeakMap<LanguageModel, string>();
const getDefaultGenerateCacheModelScope = (model: LanguageModel): string => {
  const existing = defaultGenerateCacheModelScopes.get(model);
  if (existing) {
    return existing;
  }
  const created = `model-instance:${randomUUID()}`;
  defaultGenerateCacheModelScopes.set(model, created);
  return created;
};
const telemetryObserversSymbol = Symbol("zhivex-ai.telemetry-observers");
const DEFAULT_FILE_GENERATE_CACHE_MAX_KEY_BYTES = 1024 * 1024;
const DEFAULT_FILE_GENERATE_CACHE_MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const FILE_GENERATE_CACHE_READ_CHUNK_BYTES = 64 * 1024;
const FILE_GENERATE_CACHE_SCHEMA_VERSION = 1 as const;

type TelemetryObserver<TProviderOptions extends ProviderOptions = ProviderOptions> = (
  event: LanguageModelTelemetryEvent<TProviderOptions>
) => void | Promise<void>;

type LanguageModelWithTelemetry<TProviderOptions extends ProviderOptions = ProviderOptions> = LanguageModel<TProviderOptions> & {
  [telemetryObserversSymbol]?: TelemetryObserver<TProviderOptions>[];
};

export interface GenerateCache {
  /** Persistent implementations require an explicit stable scope before middleware can read or write entries. */
  readonly scopeRequirement?: "stable";
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
  /**
   * Cache namespace for the model's authentication and tenant boundary. Use a stable value for
   * persistent caches and distinct values for distinct credentials, tenants, or upstream URLs.
   * Without an explicit scope, cache entries are isolated to the model instance and process.
   */
  scope?: string | ((input: ModelGenerateInput<TProviderOptions>, model: LanguageModel<TProviderOptions>) => string);
  /** A custom key owns the complete partitioning contract, including authentication and tenant boundaries. */
  getKey?: (input: ModelGenerateInput<TProviderOptions>, model: LanguageModel<TProviderOptions>) => string;
}): LanguageModelMiddleware<TProviderOptions> => {
  if (typeof options.scope === "string" && options.scope.trim().length === 0) {
    throw new ValidationError('The generate cache "scope" must be a non-empty string.');
  }

  return {
  name: "cache",
  async wrapGenerate(context, next) {
    if (!options.getKey && options.scope === undefined && options.cache.scopeRequirement === "stable") {
      return next();
    }
    let key: string;
    if (options.getKey) {
      key = options.getKey(context.input, context.model);
    } else {
      const scope = typeof options.scope === "function"
        ? options.scope(context.input, context.model)
        : options.scope ?? getDefaultGenerateCacheModelScope(context.model);
      if (typeof scope !== "string" || scope.trim().length === 0) {
        throw new ValidationError('The generate cache "scope" must resolve to a non-empty string.');
      }
      try {
        key = createDefaultGenerateCacheKey({
          scope,
          provider: context.model.provider,
          modelId: context.model.modelId,
          input: context.input
        });
      } catch {
        return next();
      }
    }

    const cached = await options.cache.get(key);
    if (cached) {
      return cached;
    }

    const output = await next();
    await options.cache.set(key, output);
    return output;
  }
  };
};

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

const positiveFileCacheLimit = (
  value: number | undefined,
  fallback: number,
  name: "maxKeyBytes" | "maxEntryBytes"
): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new ValidationError(`The file generate cache "${name}" limit must be a positive safe integer.`);
  }
  return resolved;
};

const readFileWithinLimit = async (filePath: string, maxBytes: number): Promise<string | undefined> => {
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) {
      return undefined;
    }

    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    while (receivedBytes <= maxBytes) {
      const chunk = Buffer.allocUnsafe(
        Math.min(FILE_GENERATE_CACHE_READ_CHUNK_BYTES, maxBytes - receivedBytes + 1)
      );
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) {
        return Buffer.concat(chunks, receivedBytes).toString("utf8");
      }

      receivedBytes += bytesRead;
      if (receivedBytes > maxBytes) {
        return undefined;
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }

    return undefined;
  } finally {
    await handle.close();
  }
};

export const createFileGenerateCache = (options: {
  dir: string;
  /** Maximum UTF-8 cache-key size. Larger keys are treated as non-cacheable. Defaults to 1 MiB. */
  maxKeyBytes?: number;
  /** Maximum serialized result size. Larger entries are treated as non-cacheable. Defaults to 16 MiB. */
  maxEntryBytes?: number;
  /** Optional entry lifetime. Expired entries are treated as cache misses and removed. */
  ttlMs?: number;
}): GenerateCache => {
  const maxKeyBytes = positiveFileCacheLimit(
    options.maxKeyBytes,
    DEFAULT_FILE_GENERATE_CACHE_MAX_KEY_BYTES,
    "maxKeyBytes"
  );
  const maxEntryBytes = positiveFileCacheLimit(
    options.maxEntryBytes,
    DEFAULT_FILE_GENERATE_CACHE_MAX_ENTRY_BYTES,
    "maxEntryBytes"
  );
  if (options.ttlMs !== undefined && (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0)) {
    throw new ValidationError('The file generate cache "ttlMs" must be a positive safe integer.');
  }
  const keyIsWithinLimit = (key: string) => Buffer.byteLength(key, "utf8") <= maxKeyBytes;
  const getPath = (key: string) =>
    path.join(options.dir, `${canonicalStoreFileStem("generate-cache", [key])}.json`);

  return {
    scopeRequirement: "stable",
    async get(key) {
      if (!keyIsWithinLimit(key)) {
        return undefined;
      }

      try {
        const file = await readFileWithinLimit(getPath(key), maxEntryBytes);
        if (file === undefined) {
          return undefined;
        }
        try {
          const parsed: unknown = JSON.parse(file);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            return undefined;
          }
          const envelope = parsed as {
            schemaVersion?: unknown;
            createdAt?: unknown;
            value?: unknown;
          };
          if (
            envelope.schemaVersion !== FILE_GENERATE_CACHE_SCHEMA_VERSION ||
            typeof envelope.createdAt !== "number" ||
            !Number.isSafeInteger(envelope.createdAt) ||
            envelope.value === null ||
            typeof envelope.value !== "object" ||
            Array.isArray(envelope.value)
          ) {
            return undefined;
          }
          if (options.ttlMs !== undefined && Date.now() - envelope.createdAt >= options.ttlMs) {
            await fs.unlink(getPath(key)).catch(() => undefined);
            return undefined;
          }
          return envelope.value as GenerateResult;
        } catch (error) {
          if (error instanceof SyntaxError) {
            return undefined;
          }
          throw error;
        }
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err?.code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    },
    async set(key, value) {
      if (!keyIsWithinLimit(key)) {
        return;
      }

      let serialized: string;
      try {
        serialized = JSON.stringify({
          schemaVersion: FILE_GENERATE_CACHE_SCHEMA_VERSION,
          createdAt: Date.now(),
          value
        });
      } catch (error) {
        if (error instanceof TypeError) {
          return;
        }
        throw error;
      }
      if (Buffer.byteLength(serialized, "utf8") > maxEntryBytes) {
        return;
      }

      await ensurePrivateDirectory(options.dir);
      await fs.chmod(options.dir, 0o700);
      await writePrivateFile(getPath(key), serialized);
    }
  };
};

export const createCircuitBreakerMiddleware = <TProviderOptions extends ProviderOptions>(options: {
  failureThreshold?: number;
  cooldownMs?: number;
  isFailure?: (error: Error) => boolean;
  /** Best-effort state observer. Observer failures do not alter model outcomes. */
  onStateChange?: (state: CircuitBreakerState & { model: LanguageModel<TProviderOptions>; status: "open" | "half-open" | "closed" }) => void | Promise<void>;
}): LanguageModelMiddleware<TProviderOptions> => {
  const failureThreshold = options.failureThreshold ?? 3;
  const cooldownMs = options.cooldownMs ?? 30_000;
  if (!Number.isSafeInteger(failureThreshold) || failureThreshold <= 0) {
    throw new ValidationError('The circuit breaker "failureThreshold" must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 0) {
    throw new ValidationError('The circuit breaker "cooldownMs" must be a non-negative safe integer.');
  }
  type InternalCircuitBreakerState = CircuitBreakerState & { halfOpenProbeInFlight: boolean };
  type CircuitBreakerPermit = {
    state: InternalCircuitBreakerState;
    halfOpenProbe: boolean;
  };
  const states = new WeakMap<LanguageModel<TProviderOptions>, InternalCircuitBreakerState>();
  const getState = (model: LanguageModel<TProviderOptions>): InternalCircuitBreakerState => {
    const existing = states.get(model);
    if (existing) {
      return existing;
    }
    const created: InternalCircuitBreakerState = { failures: 0, halfOpenProbeInFlight: false };
    states.set(model, created);
    return created;
  };
  const notifyStateChange = async (
    model: LanguageModel<TProviderOptions>,
    state: InternalCircuitBreakerState,
    status: "open" | "half-open" | "closed"
  ): Promise<void> => {
    try {
      await options.onStateChange?.({
        failures: state.failures,
        openedAt: state.openedAt,
        model,
        status
      });
    } catch {
      // State observers are operational hooks and must not alter model outcomes.
    }
  };
  const openError = (model: LanguageModel<TProviderOptions>) =>
    new Error(`Circuit breaker open for model "${model.provider}/${model.modelId}".`);

  const beginRequest = async (model: LanguageModel<TProviderOptions>): Promise<CircuitBreakerPermit> => {
    const state = getState(model);
    if (state.openedAt === undefined) {
      return { state, halfOpenProbe: false };
    }

    const cooldownElapsed = Date.now() - state.openedAt >= cooldownMs;
    if (!cooldownElapsed || state.halfOpenProbeInFlight) {
      throw openError(model);
    }

    state.halfOpenProbeInFlight = true;
    await notifyStateChange(model, state, "half-open");
    return { state, halfOpenProbe: true };
  };

  const markSuccess = async (
    model: LanguageModel<TProviderOptions>,
    permit: CircuitBreakerPermit
  ): Promise<void> => {
    const { state } = permit;
    if (!permit.halfOpenProbe && state.openedAt !== undefined) {
      return;
    }
    const changed = state.failures > 0 || state.openedAt !== undefined || state.halfOpenProbeInFlight;
    state.failures = 0;
    state.openedAt = undefined;
    state.halfOpenProbeInFlight = false;
    if (changed) {
      await notifyStateChange(model, state, "closed");
    }
  };

  const markFailure = async (
    model: LanguageModel<TProviderOptions>,
    permit: CircuitBreakerPermit,
    error: unknown
  ): Promise<void> => {
    const { state } = permit;
    const err = error instanceof Error ? error : new Error(String(error));
    let isFailure = true;
    try {
      isFailure = options.isFailure?.(err) ?? true;
    } catch {
      isFailure = true;
    }
    if (!isFailure) {
      if (permit.halfOpenProbe) {
        await markSuccess(model, permit);
      }
      return;
    }

    const wasOpen = state.openedAt !== undefined;
    state.failures += 1;
    if (permit.halfOpenProbe) {
      state.halfOpenProbeInFlight = false;
      state.openedAt = Date.now();
      await notifyStateChange(model, state, "open");
    } else if (!wasOpen && state.failures >= failureThreshold) {
      state.openedAt = Date.now();
      await notifyStateChange(model, state, "open");
    }
  };

  return {
    name: "circuit-breaker",
    async wrapGenerate(context, next) {
      const permit = await beginRequest(context.model);
      try {
        const result = await next();
        await markSuccess(context.model, permit);
        return result;
      } catch (error) {
        await markFailure(context.model, permit, error);
        throw error;
      }
    },
    async wrapStream(context, next) {
      return (async function* (): AsyncGenerator<StreamEvent> {
        const permit = await beginRequest(context.model);
        let settled = false;
        try {
          const stream = await next();
          for await (const event of stream) {
            yield event;
          }
          await markSuccess(context.model, permit);
          settled = true;
        } catch (error) {
          await markFailure(context.model, permit, error);
          settled = true;
          throw error;
        } finally {
          if (!settled && permit.halfOpenProbe) {
            permit.state.halfOpenProbeInFlight = false;
          }
        }
      })();
    }
  };
};
