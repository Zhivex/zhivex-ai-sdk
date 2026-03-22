import type {
  GenerateResult,
  LanguageModel,
  LanguageModelMiddleware,
  LanguageModelTelemetryEvent,
  ModelGenerateInput,
  ProviderOptions
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

  return {
    ...model,
    async generate(input: ModelGenerateInput<TProviderOptions>): Promise<GenerateResult> {
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
    },
    stream: model.stream?.bind(model)
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
