import type { ModelCatalog, ModelCatalogEntry } from "./catalog.js";
import { ConfigurationError } from "./errors.js";
import type { LanguageModel, ModelCapabilities, ProviderAdapter } from "./types.js";

const MAX_PROVIDER_LENGTH = 128;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_ALIAS_LENGTH = 128;

export type ModelResolutionErrorCode =
  | "invalid_configuration"
  | "invalid_identifier"
  | "alias_collision"
  | "unknown_alias"
  | "unknown_provider"
  | "unknown_model"
  | "invalid_resolved_model";

/** Typed, preflight-only failure raised by the optional model resolver. */
export class ModelResolutionError extends ConfigurationError {
  constructor(
    readonly code: ModelResolutionErrorCode,
    message: string,
    readonly details: {
      identifier?: string;
      provider?: string;
      modelId?: string;
      alias?: string;
    } = {},
    options?: { cause?: unknown }
  ) {
    super(message, options);
  }
}

export interface ModelReference {
  readonly provider: string;
  readonly modelId: string;
}

export interface ModelResolverAlias {
  /** Application-owned shorthand. Aliases cannot contain `/`, so they never shadow explicit identifiers. */
  readonly alias: string;
  /** Explicit provider/model target or its structured equivalent. Alias chains are intentionally unsupported. */
  readonly target: string | ModelReference;
}

export interface ModelResolverBackend<TLanguageModel extends LanguageModel = LanguageModel> {
  /** Safe, application-defined label emitted in resolution metadata. Never use an endpoint or credential here. */
  readonly name: string;
  languageModel(reference: ModelReference): TLanguageModel;
}

export interface ModelResolutionCatalogMetadata {
  readonly schemaVersion: number;
  readonly contractVersion: string;
  readonly snapshotVersion: string;
  readonly pricingVersion?: string;
  readonly currency?: string;
}

export interface ModelResolutionSourceMetadata {
  readonly kind: "adapter" | "backend";
  readonly name: string;
}

export type ModelResolutionCatalogEntry = Readonly<
  Omit<ModelCatalogEntry, "aliases" | "longContextPricing" | "recommendedFor">
> & {
  readonly aliases?: ReadonlyArray<NonNullable<ModelCatalogEntry["aliases"]>[number]>;
  readonly longContextPricing?: Readonly<NonNullable<ModelCatalogEntry["longContextPricing"]>>;
  readonly recommendedFor?: ReadonlyArray<NonNullable<ModelCatalogEntry["recommendedFor"]>[number]>;
};

export type ModelResolutionCapabilities = Readonly<
  Omit<
    ModelCapabilities,
    "reasoningEfforts" | "reasoningModes" | "reasoningContexts" | "realtime" | "agentCapabilities"
  >
> & {
  readonly reasoningEfforts?: ReadonlyArray<NonNullable<ModelCapabilities["reasoningEfforts"]>[number]>;
  readonly reasoningModes?: ReadonlyArray<NonNullable<ModelCapabilities["reasoningModes"]>[number]>;
  readonly reasoningContexts?: ReadonlyArray<NonNullable<ModelCapabilities["reasoningContexts"]>[number]>;
  readonly realtime?: Readonly<NonNullable<ModelCapabilities["realtime"]>>;
  readonly agentCapabilities?: Readonly<NonNullable<ModelCapabilities["agentCapabilities"]>>;
};

export interface ModelResolutionMetadata {
  readonly schemaVersion: 1;
  /** Exact, validated application input. */
  readonly identifier: string;
  /** Explicit target after expanding an application alias, before catalog aliases are canonicalized. */
  readonly requested: Readonly<ModelReference>;
  /** Canonical identity from the injected catalog. */
  readonly resolved: Readonly<ModelReference>;
  readonly alias?: string;
  readonly source: Readonly<ModelResolutionSourceMetadata>;
  readonly catalog: Readonly<ModelResolutionCatalogMetadata>;
  readonly catalogEntry: ModelResolutionCatalogEntry;
  readonly capabilities: ModelResolutionCapabilities;
}

export interface ModelResolution<TLanguageModel extends LanguageModel = LanguageModel> {
  readonly model: TLanguageModel;
  readonly metadata: ModelResolutionMetadata;
}

export interface ModelResolver<TLanguageModel extends LanguageModel = LanguageModel> {
  /** Resolve both the existing provider model and immutable trace/budget metadata. */
  resolve(identifier: string): ModelResolution<TLanguageModel>;
  /** Convenience path for passing a resolved model directly to generateText, Agent, or another runtime API. */
  model(identifier: string): TLanguageModel;
}

interface ModelResolverSharedOptions {
  /** Explicit immutable inventory used to reject unknown providers/models before adapter or backend execution. */
  catalog: ModelCatalog;
  aliases?: readonly ModelResolverAlias[];
  /** Receives frozen, secret-free metadata after a successful local resolution. */
  onResolve?: (metadata: ModelResolutionMetadata) => void;
}

export type CreateModelResolverOptions<TLanguageModel extends LanguageModel = LanguageModel> =
  ModelResolverSharedOptions &
    (
      | {
          adapters: Readonly<Record<string, ProviderAdapter<TLanguageModel>>>;
          backend?: never;
        }
      | {
          adapters?: never;
          backend: ModelResolverBackend<TLanguageModel>;
        }
    );

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isObjectOrFunction = (value: unknown): value is Record<string, unknown> =>
  (typeof value === "object" && value !== null) || typeof value === "function";

const hasControlCharacters = (value: string): boolean => /[\u0000-\u001f\u007f]/u.test(value);

const validateProvider = (provider: unknown): provider is string =>
  typeof provider === "string" &&
  provider.length > 0 &&
  provider.length <= MAX_PROVIDER_LENGTH &&
  provider === provider.trim() &&
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(provider);

const validateModelId = (modelId: unknown): modelId is string =>
  typeof modelId === "string" &&
  modelId.length > 0 &&
  modelId.length <= MAX_MODEL_ID_LENGTH &&
  modelId === modelId.trim() &&
  !modelId.includes("://") &&
  !hasControlCharacters(modelId);

const invalidIdentifier = (message: string): never => {
  throw new ModelResolutionError("invalid_identifier", message);
};

const normalizeReference = (input: string | ModelReference): ModelReference => {
  if (typeof input === "string") {
    if (input.length === 0 || input !== input.trim() || hasControlCharacters(input)) {
      return invalidIdentifier(
        "Model identifiers must be non-empty and must not contain surrounding whitespace or control characters."
      );
    }
    const separator = input.indexOf("/");
    if (separator <= 0 || separator === input.length - 1) {
      return invalidIdentifier('Model identifiers must use the explicit "provider/model" format.');
    }
    return normalizeReference({
      provider: input.slice(0, separator),
      modelId: input.slice(separator + 1)
    });
  }

  if (!isObject(input) || !validateProvider(input.provider) || !validateModelId(input.modelId)) {
    return invalidIdentifier(
      `Model references require a provider of at most ${MAX_PROVIDER_LENGTH} safe characters and a modelId of at most ${MAX_MODEL_ID_LENGTH} characters.`
    );
  }

  return Object.freeze({ provider: input.provider, modelId: input.modelId });
};

const normalizeAlias = (alias: unknown): string => {
  if (
    typeof alias !== "string" ||
    alias.length === 0 ||
    alias.length > MAX_ALIAS_LENGTH ||
    alias !== alias.trim() ||
    alias.includes("/") ||
    hasControlCharacters(alias)
  ) {
    throw new ModelResolutionError(
      "invalid_configuration",
      `Model aliases must be non-empty, contain no slash, and be at most ${MAX_ALIAS_LENGTH} characters.`
    );
  }
  return alias;
};

const requiredCapabilityBooleans = [
  "streaming",
  "tools",
  "structuredOutput",
  "jsonMode",
  "toolChoice",
  "parallelToolCalls",
  "vision",
  "files",
  "audioInput",
  "audioOutput",
  "embeddings",
  "reasoning",
  "webSearch"
] as const;

const optionalCapabilityBooleans = [
  "imageGeneration",
  "videoGeneration",
  "musicGeneration",
  "fileSearch",
  "urlContext",
  "contextCaching",
  "explicitPromptCaching",
  "batch",
  "interactions",
  "rawPrediction",
  "computerUse"
] as const;

const hasBooleanFields = (value: Record<string, unknown>, fields: readonly string[]): boolean =>
  fields.every((field) => typeof value[field] === "boolean");

const hasOptionalBooleanFields = (value: Record<string, unknown>, fields: readonly string[]): boolean =>
  fields.every((field) => value[field] === undefined || typeof value[field] === "boolean");

const isStringArrayOrUndefined = (value: unknown): boolean =>
  value === undefined || (Array.isArray(value) && value.every((entry) => typeof entry === "string"));

const isModelCapabilities = (value: unknown): value is ModelCapabilities => {
  if (
    !isObject(value) ||
    !hasBooleanFields(value, requiredCapabilityBooleans) ||
    !hasOptionalBooleanFields(value, optionalCapabilityBooleans) ||
    !isStringArrayOrUndefined(value.reasoningEfforts) ||
    !isStringArrayOrUndefined(value.reasoningModes) ||
    !isStringArrayOrUndefined(value.reasoningContexts)
  ) {
    return false;
  }

  if (
    value.realtime !== undefined &&
    (!isObject(value.realtime) ||
      !hasBooleanFields(value.realtime, [
        "sessions",
        "audioInput",
        "audioOutput",
        "imageInput",
        "tools",
        "browserTokens"
      ]))
  ) {
    return false;
  }

  if (value.agentCapabilities !== undefined) {
    const agent = value.agentCapabilities;
    if (
      !isObject(agent) ||
      (agent.supportTier !== "tier-a" && agent.supportTier !== "tier-b" && agent.supportTier !== "tier-c") ||
      !hasBooleanFields(agent, [
        "toolChoiceNone",
        "approvalRequests",
        "hostedWebSearch",
        "hostedFileSearch",
        "remoteMcp",
        "computerUse",
        "codeExecution",
        "toolsets"
      ]) ||
      !hasOptionalBooleanFields(agent, [
        "shell",
        "applyPatch",
        "toolSearch",
        "webExtraction",
        "skills",
        "programmaticToolCalling",
        "multiAgent"
      ])
    ) {
      return false;
    }
  }

  return true;
};

const cloneCatalogEntry = (entry: ModelCatalogEntry): ModelResolutionCatalogEntry => {
  const clone: ModelCatalogEntry = {
    provider: entry.provider,
    modelId: entry.modelId,
    ...(entry.aliases === undefined ? {} : { aliases: Object.freeze([...entry.aliases]) as string[] }),
    ...(entry.inputCostPer1kTokens === undefined ? {} : { inputCostPer1kTokens: entry.inputCostPer1kTokens }),
    ...(entry.cachedInputCostPer1kTokens === undefined
      ? {}
      : { cachedInputCostPer1kTokens: entry.cachedInputCostPer1kTokens }),
    ...(entry.cacheWriteCostPer1kTokens === undefined
      ? {}
      : { cacheWriteCostPer1kTokens: entry.cacheWriteCostPer1kTokens }),
    ...(entry.outputCostPer1kTokens === undefined ? {} : { outputCostPer1kTokens: entry.outputCostPer1kTokens }),
    ...(entry.costPer1kTokens === undefined ? {} : { costPer1kTokens: entry.costPer1kTokens }),
    ...(entry.longContextPricing === undefined
      ? {}
      : { longContextPricing: Object.freeze({ ...entry.longContextPricing }) }),
    ...(entry.recommendedFor === undefined
      ? {}
      : { recommendedFor: Object.freeze([...entry.recommendedFor]) as ModelCatalogEntry["recommendedFor"] })
  };
  return Object.freeze(clone) as ModelResolutionCatalogEntry;
};

const cloneCapabilities = (capabilities: ModelCapabilities): ModelResolutionCapabilities => {
  const clone: ModelCapabilities = {
    streaming: capabilities.streaming,
    tools: capabilities.tools,
    structuredOutput: capabilities.structuredOutput,
    jsonMode: capabilities.jsonMode,
    toolChoice: capabilities.toolChoice,
    parallelToolCalls: capabilities.parallelToolCalls,
    vision: capabilities.vision,
    files: capabilities.files,
    audioInput: capabilities.audioInput,
    audioOutput: capabilities.audioOutput,
    embeddings: capabilities.embeddings,
    reasoning: capabilities.reasoning,
    webSearch: capabilities.webSearch,
    ...(capabilities.imageGeneration === undefined ? {} : { imageGeneration: capabilities.imageGeneration }),
    ...(capabilities.videoGeneration === undefined ? {} : { videoGeneration: capabilities.videoGeneration }),
    ...(capabilities.musicGeneration === undefined ? {} : { musicGeneration: capabilities.musicGeneration }),
    ...(capabilities.fileSearch === undefined ? {} : { fileSearch: capabilities.fileSearch }),
    ...(capabilities.urlContext === undefined ? {} : { urlContext: capabilities.urlContext }),
    ...(capabilities.contextCaching === undefined ? {} : { contextCaching: capabilities.contextCaching }),
    ...(capabilities.explicitPromptCaching === undefined
      ? {}
      : { explicitPromptCaching: capabilities.explicitPromptCaching }),
    ...(capabilities.batch === undefined ? {} : { batch: capabilities.batch }),
    ...(capabilities.interactions === undefined ? {} : { interactions: capabilities.interactions }),
    ...(capabilities.rawPrediction === undefined ? {} : { rawPrediction: capabilities.rawPrediction }),
    ...(capabilities.computerUse === undefined ? {} : { computerUse: capabilities.computerUse }),
    ...(capabilities.reasoningEfforts === undefined
      ? {}
      : { reasoningEfforts: Object.freeze([...capabilities.reasoningEfforts]) as ModelCapabilities["reasoningEfforts"] }),
    ...(capabilities.reasoningModes === undefined
      ? {}
      : { reasoningModes: Object.freeze([...capabilities.reasoningModes]) as ModelCapabilities["reasoningModes"] }),
    ...(capabilities.reasoningContexts === undefined
      ? {}
      : { reasoningContexts: Object.freeze([...capabilities.reasoningContexts]) as ModelCapabilities["reasoningContexts"] }),
    ...(capabilities.realtime === undefined
      ? {}
      : {
          realtime: Object.freeze({
            sessions: capabilities.realtime.sessions,
            audioInput: capabilities.realtime.audioInput,
            audioOutput: capabilities.realtime.audioOutput,
            imageInput: capabilities.realtime.imageInput,
            tools: capabilities.realtime.tools,
            browserTokens: capabilities.realtime.browserTokens
          })
        }),
    ...(capabilities.agentCapabilities === undefined
      ? {}
      : {
          agentCapabilities: Object.freeze({
            supportTier: capabilities.agentCapabilities.supportTier,
            toolChoiceNone: capabilities.agentCapabilities.toolChoiceNone,
            approvalRequests: capabilities.agentCapabilities.approvalRequests,
            hostedWebSearch: capabilities.agentCapabilities.hostedWebSearch,
            hostedFileSearch: capabilities.agentCapabilities.hostedFileSearch,
            remoteMcp: capabilities.agentCapabilities.remoteMcp,
            computerUse: capabilities.agentCapabilities.computerUse,
            codeExecution: capabilities.agentCapabilities.codeExecution,
            toolsets: capabilities.agentCapabilities.toolsets,
            ...(capabilities.agentCapabilities.shell === undefined
              ? {}
              : { shell: capabilities.agentCapabilities.shell }),
            ...(capabilities.agentCapabilities.applyPatch === undefined
              ? {}
              : { applyPatch: capabilities.agentCapabilities.applyPatch }),
            ...(capabilities.agentCapabilities.toolSearch === undefined
              ? {}
              : { toolSearch: capabilities.agentCapabilities.toolSearch }),
            ...(capabilities.agentCapabilities.webExtraction === undefined
              ? {}
              : { webExtraction: capabilities.agentCapabilities.webExtraction }),
            ...(capabilities.agentCapabilities.skills === undefined
              ? {}
              : { skills: capabilities.agentCapabilities.skills }),
            ...(capabilities.agentCapabilities.programmaticToolCalling === undefined
              ? {}
              : { programmaticToolCalling: capabilities.agentCapabilities.programmaticToolCalling }),
            ...(capabilities.agentCapabilities.multiAgent === undefined
              ? {}
              : { multiAgent: capabilities.agentCapabilities.multiAgent })
          })
        })
  };
  return Object.freeze(clone) as ModelResolutionCapabilities;
};

const assertResolvedModel = <TLanguageModel extends LanguageModel>(model: TLanguageModel): TLanguageModel => {
  if (
    !isObject(model) ||
    !validateProvider(model.provider) ||
    !validateModelId(model.modelId) ||
    !isModelCapabilities(model.capabilities) ||
    typeof model.generate !== "function"
  ) {
    throw new ModelResolutionError(
      "invalid_resolved_model",
      "The configured adapter or backend returned an invalid language model before any model call was made."
    );
  }
  return model;
};

const assertCatalog: (catalog: unknown) => asserts catalog is ModelCatalog = (catalog) => {
  if (!isObject(catalog) || typeof catalog.find !== "function" || typeof catalog.list !== "function") {
    throw new ModelResolutionError(
      "invalid_configuration",
      "createModelResolver requires an explicit ModelCatalog instance."
    );
  }
};

/**
 * Creates an instance-local, immutable Beta registry for optional provider/model identifiers.
 * Direct provider factories remain the canonical low-level path.
 */
export const createModelResolver = <TLanguageModel extends LanguageModel = LanguageModel>(
  options: CreateModelResolverOptions<TLanguageModel>
): ModelResolver<TLanguageModel> => {
  if (!isObject(options)) {
    throw new ModelResolutionError("invalid_configuration", "createModelResolver options must be an object.");
  }
  assertCatalog(options.catalog);
  const catalog = options.catalog;
  const onResolve = options.onResolve;

  const hasAdapters = options.adapters !== undefined;
  const hasBackend = options.backend !== undefined;
  if (hasAdapters === hasBackend) {
    throw new ModelResolutionError(
      "invalid_configuration",
      "createModelResolver requires exactly one explicit source: adapters or backend."
    );
  }
  if (options.onResolve !== undefined && typeof options.onResolve !== "function") {
    throw new ModelResolutionError("invalid_configuration", "createModelResolver onResolve must be a function.");
  }

  const catalogEntries = catalog.list();
  const catalogProviders = new Set(catalogEntries.map((entry) => entry.provider));
  const catalogMetadata = catalog.metadata;
  const catalogTraceMetadata: Readonly<ModelResolutionCatalogMetadata> = Object.freeze({
    schemaVersion: catalogMetadata.schemaVersion,
    contractVersion: catalogMetadata.contractVersion,
    snapshotVersion: catalogMetadata.snapshotVersion,
    ...(catalogMetadata.pricing?.version === undefined
      ? {}
      : { pricingVersion: catalogMetadata.pricing.version }),
    ...(catalogMetadata.pricing?.currency === undefined ? {} : { currency: catalogMetadata.pricing.currency })
  });

  let adapters: Readonly<Record<string, ProviderAdapter<TLanguageModel>>> | undefined;
  let backend: ModelResolverBackend<TLanguageModel> | undefined;
  if (hasAdapters) {
    if (!isObject(options.adapters)) {
      throw new ModelResolutionError("invalid_configuration", "createModelResolver adapters must be an object.");
    }
    const adapterSnapshot: Record<string, ProviderAdapter<TLanguageModel>> = {};
    for (const [provider, adapter] of Object.entries(options.adapters)) {
      if (!validateProvider(provider) || !isObjectOrFunction(adapter) || typeof adapter.languageModel !== "function") {
        throw new ModelResolutionError(
          "invalid_configuration",
          "Every model resolver adapter requires a safe provider key and a languageModel factory."
        );
      }
      adapterSnapshot[provider] = adapter;
    }
    adapters = Object.freeze(adapterSnapshot);
  } else {
    if (
      !isObject(options.backend) ||
      !validateProvider(options.backend.name) ||
      typeof options.backend.languageModel !== "function"
    ) {
      throw new ModelResolutionError(
        "invalid_configuration",
        "A model resolver backend requires a safe name and a languageModel factory."
      );
    }
    backend = options.backend;
  }

  const findCatalogEntry = (reference: ModelReference): ModelCatalogEntry => {
    if (!catalogProviders.has(reference.provider)) {
      throw new ModelResolutionError(
        "unknown_provider",
        "The requested model provider is not present in the configured catalog."
      );
    }
    if (adapters !== undefined && !Object.prototype.hasOwnProperty.call(adapters, reference.provider)) {
      throw new ModelResolutionError(
        "unknown_provider",
        "The requested model provider is not configured in this resolver."
      );
    }
    const entry = catalog.find(reference.provider, reference.modelId);
    if (entry === undefined) {
      throw new ModelResolutionError(
        "unknown_model",
        "The requested model is not present for its provider in the configured catalog."
      );
    }
    return entry;
  };

  const aliases = new Map<string, ModelReference>();
  if (options.aliases !== undefined) {
    if (!Array.isArray(options.aliases)) {
      throw new ModelResolutionError("invalid_configuration", "createModelResolver aliases must be an array.");
    }
    for (const aliasDefinition of options.aliases) {
      if (!isObject(aliasDefinition)) {
        throw new ModelResolutionError("invalid_configuration", "Every model resolver alias must be an object.");
      }
      const alias = normalizeAlias(aliasDefinition.alias);
      if (aliases.has(alias)) {
        throw new ModelResolutionError(
          "alias_collision",
          "A model alias is configured more than once."
        );
      }
      const rawTarget = aliasDefinition.target;
      if (typeof rawTarget !== "string" && !isObject(rawTarget)) {
        throw new ModelResolutionError(
          "invalid_configuration",
          "Every model resolver alias target must be an explicit provider/model string or reference."
        );
      }
      const target = normalizeReference(rawTarget as string | ModelReference);
      findCatalogEntry(target);
      aliases.set(alias, target);
    }
  }

  const resolve = (identifier: string): ModelResolution<TLanguageModel> => {
    if (typeof identifier !== "string") {
      return invalidIdentifier("Model identifiers must be strings.");
    }
    const aliasTarget = aliases.get(identifier);
    if (!identifier.includes("/") && aliasTarget === undefined) {
      const alias = normalizeAlias(identifier);
      throw new ModelResolutionError(
        "unknown_alias",
        "The requested model alias is not configured in this resolver."
      );
    }

    const requested = aliasTarget ?? normalizeReference(identifier);
    const entry = findCatalogEntry(requested);
    const canonical = Object.freeze({ provider: entry.provider, modelId: entry.modelId });
    const source = adapters === undefined
      ? Object.freeze({ kind: "backend" as const, name: backend!.name })
      : Object.freeze({ kind: "adapter" as const, name: canonical.provider });
    const model = assertResolvedModel(
      adapters === undefined
        ? backend!.languageModel(canonical)
        : adapters[canonical.provider]!.languageModel(canonical.modelId)
    );
    const metadata: ModelResolutionMetadata = Object.freeze({
      schemaVersion: 1 as const,
      identifier,
      requested: Object.freeze({ ...requested }),
      resolved: canonical,
      ...(aliasTarget === undefined ? {} : { alias: identifier }),
      source,
      catalog: catalogTraceMetadata,
      catalogEntry: cloneCatalogEntry(entry),
      capabilities: cloneCapabilities(model.capabilities)
    });
    onResolve?.(metadata);
    return Object.freeze({ model, metadata });
  };

  return Object.freeze({
    resolve,
    model(identifier: string) {
      return resolve(identifier).model;
    }
  });
};
