import type { ZodTypeAny } from "zod";

import { estimateTokenCost, type CostEstimate, type TokenPricing } from "./agent-trace.js";
import type { ModelCatalog, ModelCatalogEntry } from "./catalog.js";
import { embed } from "./embed.js";
import { ValidationError } from "./errors.js";
import { generateText } from "./generate-text.js";
import { cosineSimilarity } from "./retrieval.js";
import type {
  EmbeddingModel,
  FinishReason,
  GenerateTextOptions,
  JsonValue,
  LanguageModel,
  ModelMessage,
  TokenUsage,
  ToolExecutionResult
} from "./types.js";

export const MODEL_EVALUATION_REPORT_SCHEMA_VERSION = 1 as const;

export interface ModelEvaluationCase {
  name: string;
  prompt?: string;
  messages?: ModelMessage[];
  reference?: JsonValue;
  expectedToolCalls?: string[];
  settings?: ModelEvaluationGenerationSettings;
  metadata?: Record<string, JsonValue>;
}

export type ModelEvaluationGenerationSettings = Omit<
  GenerateTextOptions<LanguageModel>,
  "model" | "prompt" | "messages"
>;

export interface ModelEvaluationCandidate {
  id: string;
  model: LanguageModel;
  settings?: ModelEvaluationGenerationSettings;
  pricing?: TokenPricing;
  metadata?: Record<string, JsonValue>;
}

export interface ModelEvaluationScore {
  scorerId: string;
  score?: number;
  feedback?: string;
  metadata?: Record<string, JsonValue>;
  error?: string;
}

export interface ModelEvaluationScorerResult {
  score: number;
  feedback?: string;
  metadata?: Record<string, JsonValue>;
}

export interface ModelEvaluationScorerContext {
  testCase: ModelEvaluationCase;
  candidate: Pick<ModelEvaluationCandidate, "id" | "metadata"> & {
    provider: string;
    modelId: string;
  };
  repetition: number;
  outputText?: string;
  finishReason?: FinishReason;
  usage?: TokenUsage;
  toolResults: ToolExecutionResult[];
  latencyMs: number;
  cost?: CostEstimate;
  error?: string;
}

export interface ModelEvaluationScorer {
  id: string;
  score(
    context: ModelEvaluationScorerContext
  ): number | ModelEvaluationScorerResult | Promise<number | ModelEvaluationScorerResult>;
}

export interface ModelEvaluationRunResult {
  caseName: string;
  candidateId: string;
  provider: string;
  modelId: string;
  repetition: number;
  ok: boolean;
  outputText?: string;
  finishReason?: FinishReason;
  usage?: TokenUsage;
  toolCalls: string[];
  latencyMs: number;
  cost?: CostEstimate;
  scores: ModelEvaluationScore[];
  meanScore?: number;
  error?: string;
  caseMetadata?: Record<string, JsonValue>;
  candidateMetadata?: Record<string, JsonValue>;
}

export interface ModelEvaluationCandidateSummary {
  candidateId: string;
  provider: string;
  modelId: string;
  runs: number;
  successfulRuns: number;
  failedRuns: number;
  errorRate: number;
  meanScore?: number;
  minScore?: number;
  maxScore?: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  totalCost?: number;
  meanCost?: number;
  currency?: string;
  usage?: TokenUsage;
  metadata?: Record<string, JsonValue>;
}

export interface ModelEvaluationThresholds {
  minMeanScore?: number;
  maxTotalCost?: number;
  maxP95LatencyMs?: number;
  maxErrorRate?: number;
}

export type ModelEvaluationGateCheckCode =
  | "min_mean_score"
  | "max_total_cost"
  | "max_p95_latency_ms"
  | "max_error_rate";

export interface ModelEvaluationGateCheck {
  candidateId: string;
  code: ModelEvaluationGateCheckCode;
  ok: boolean;
  actual?: number;
  threshold: number;
  message: string;
}

export interface ModelEvaluationGateResult {
  ok: boolean;
  thresholds: ModelEvaluationThresholds;
  checks: ModelEvaluationGateCheck[];
}

export interface ModelEvaluationReport {
  schemaVersion: typeof MODEL_EVALUATION_REPORT_SCHEMA_VERSION;
  createdAt: string;
  ok: boolean;
  repetitions: number;
  totalRuns: number;
  cases: string[];
  candidates: ModelEvaluationCandidateSummary[];
  runs: ModelEvaluationRunResult[];
  gate?: ModelEvaluationGateResult;
  metadata?: Record<string, JsonValue>;
}

export interface ModelEvaluationSuite {
  cases: ModelEvaluationCase[];
  candidates: ModelEvaluationCandidate[];
  scorers: ModelEvaluationScorer[];
  repetitions?: number;
  maxConcurrency?: number;
  catalog?: ModelCatalog;
  thresholds?: ModelEvaluationThresholds;
  metadata?: Record<string, JsonValue>;
}

export interface ModelEvaluationCandidateComparison {
  candidateId: string;
  baseline?: ModelEvaluationCandidateSummary;
  target?: ModelEvaluationCandidateSummary;
  scoreDelta?: number;
  totalCostDelta?: number;
  p95LatencyDeltaMs?: number;
  errorRateDelta?: number;
}

export interface ModelEvaluationComparison {
  baselineCreatedAt: string;
  targetCreatedAt: string;
  candidates: ModelEvaluationCandidateComparison[];
}

function assertNonEmptyIdentifier(value: unknown, path: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ValidationError(`${path} must be a non-empty string without surrounding whitespace or control characters.`);
  }
}

function assertFiniteRange(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ValidationError(`${path} must be a finite number between ${minimum} and ${maximum}.`);
  }
}

const normalizeError = (error: unknown): string => error instanceof Error ? error.message : String(error);

const percentile = (values: number[], quantile: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
  return sorted[index] ?? 0;
};

const mean = (values: number[]): number | undefined =>
  values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;

const sumUsage = (usages: Array<TokenUsage | undefined>): TokenUsage | undefined => {
  const present = usages.filter((usage): usage is TokenUsage => usage !== undefined);
  if (present.length === 0) {
    return undefined;
  }
  const fields = [
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteTokens",
    "outputTokens",
    "reasoningTokens",
    "totalTokens"
  ] as const;
  const total: TokenUsage = {};
  for (const field of fields) {
    const values = present.map((usage) => usage[field]).filter((value): value is number => value !== undefined);
    if (values.length > 0) {
      total[field] = values.reduce((sum, value) => sum + value, 0);
    }
  }
  const speeds = new Set(present.map((usage) => usage.speed).filter((value): value is NonNullable<TokenUsage["speed"]> => value !== undefined));
  if (speeds.size === 1) {
    total.speed = [...speeds][0];
  }
  return total;
};

const catalogPricing = (catalog: ModelCatalog | undefined, candidate: ModelEvaluationCandidate): TokenPricing | undefined => {
  if (candidate.pricing) {
    return candidate.pricing;
  }
  const entry = catalog?.find(candidate.model.provider, candidate.model.modelId);
  if (!entry) {
    return undefined;
  }
  return pricingFromCatalogEntry(entry, catalog?.metadata.pricing?.currency);
};

const pricingFromCatalogEntry = (entry: ModelCatalogEntry, currency?: string): TokenPricing => ({
  inputCostPer1kTokens: entry.inputCostPer1kTokens,
  cachedInputCostPer1kTokens: entry.cachedInputCostPer1kTokens,
  cacheWriteCostPer1kTokens: entry.cacheWriteCostPer1kTokens,
  outputCostPer1kTokens: entry.outputCostPer1kTokens,
  costPer1kTokens: entry.costPer1kTokens,
  longContextPricing: entry.longContextPricing,
  currency
});

const validateSuite = (suite: ModelEvaluationSuite): { repetitions: number; maxConcurrency: number } => {
  if (!Array.isArray(suite.cases) || suite.cases.length === 0) {
    throw new ValidationError("Model evaluation requires at least one case.");
  }
  if (!Array.isArray(suite.candidates) || suite.candidates.length === 0) {
    throw new ValidationError("Model evaluation requires at least one candidate.");
  }
  if (!Array.isArray(suite.scorers) || suite.scorers.length === 0) {
    throw new ValidationError("Model evaluation requires at least one scorer.");
  }

  const caseNames = new Set<string>();
  for (const [index, testCase] of suite.cases.entries()) {
    assertNonEmptyIdentifier(testCase.name, `cases[${index}].name`);
    if (caseNames.has(testCase.name)) {
      throw new ValidationError(`Duplicate model evaluation case name ${JSON.stringify(testCase.name)}.`);
    }
    caseNames.add(testCase.name);
    if ((testCase.prompt === undefined) === (testCase.messages === undefined)) {
      throw new ValidationError(`Case ${JSON.stringify(testCase.name)} must define exactly one of prompt or messages.`);
    }
    if (testCase.messages !== undefined && !Array.isArray(testCase.messages)) {
      throw new ValidationError(`Case ${JSON.stringify(testCase.name)} messages must be an array.`);
    }
  }

  const candidateIds = new Set<string>();
  for (const [index, candidate] of suite.candidates.entries()) {
    assertNonEmptyIdentifier(candidate.id, `candidates[${index}].id`);
    if (candidateIds.has(candidate.id)) {
      throw new ValidationError(`Duplicate model evaluation candidate id ${JSON.stringify(candidate.id)}.`);
    }
    candidateIds.add(candidate.id);
    if (!candidate.model || typeof candidate.model.generate !== "function") {
      throw new ValidationError(`Candidate ${JSON.stringify(candidate.id)} must define a language model.`);
    }
  }

  const scorerIds = new Set<string>();
  for (const [index, scorer] of suite.scorers.entries()) {
    assertNonEmptyIdentifier(scorer.id, `scorers[${index}].id`);
    if (scorerIds.has(scorer.id)) {
      throw new ValidationError(`Duplicate model evaluation scorer id ${JSON.stringify(scorer.id)}.`);
    }
    scorerIds.add(scorer.id);
    if (typeof scorer.score !== "function") {
      throw new ValidationError(`Scorer ${JSON.stringify(scorer.id)} must define score().`);
    }
  }

  const repetitions = suite.repetitions ?? 1;
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 100) {
    throw new ValidationError("Model evaluation repetitions must be a safe integer between 1 and 100.");
  }
  const maxConcurrency = suite.maxConcurrency ?? 4;
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 64) {
    throw new ValidationError("Model evaluation maxConcurrency must be a safe integer between 1 and 64.");
  }
  validateThresholds(suite.thresholds);
  return { repetitions, maxConcurrency };
};

const validateThresholds = (thresholds: ModelEvaluationThresholds | undefined): void => {
  if (!thresholds) {
    return;
  }
  if (thresholds.minMeanScore !== undefined) {
    assertFiniteRange(thresholds.minMeanScore, "thresholds.minMeanScore", 0, 1);
  }
  if (thresholds.maxErrorRate !== undefined) {
    assertFiniteRange(thresholds.maxErrorRate, "thresholds.maxErrorRate", 0, 1);
  }
  for (const field of ["maxTotalCost", "maxP95LatencyMs"] as const) {
    const value = thresholds[field];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      throw new ValidationError(`thresholds.${field} must be a finite, non-negative number.`);
    }
  }
};

const normalizeScorerResult = (scorerId: string, result: number | ModelEvaluationScorerResult): ModelEvaluationScore => {
  const normalized = typeof result === "number" ? { score: result } : result;
  assertFiniteRange(normalized.score, `Scorer ${JSON.stringify(scorerId)} score`, 0, 1);
  return {
    scorerId,
    score: normalized.score,
    feedback: normalized.feedback,
    metadata: normalized.metadata
  };
};

const evaluateSingleRun = async (
  testCase: ModelEvaluationCase,
  candidate: ModelEvaluationCandidate,
  repetition: number,
  suite: ModelEvaluationSuite
): Promise<ModelEvaluationRunResult> => {
  const startedAt = Date.now();
  let outputText: string | undefined;
  let finishReason: FinishReason | undefined;
  let usage: TokenUsage | undefined;
  let toolResults: ToolExecutionResult[] = [];
  let error: string | undefined;

  try {
    const input = testCase.prompt === undefined
      ? { messages: testCase.messages! }
      : { prompt: testCase.prompt };
    const output = await generateText({
      ...candidate.settings,
      ...testCase.settings,
      ...input,
      model: candidate.model
    });
    outputText = output.text;
    finishReason = output.finishReason;
    usage = output.usage;
    toolResults = output.toolResults;
  } catch (cause) {
    error = normalizeError(cause);
  }

  const latencyMs = Math.max(0, Date.now() - startedAt);
  const cost = estimateTokenCost(usage, catalogPricing(suite.catalog, candidate));
  const context: ModelEvaluationScorerContext = {
    testCase,
    candidate: {
      id: candidate.id,
      provider: candidate.model.provider,
      modelId: candidate.model.modelId,
      metadata: candidate.metadata
    },
    repetition,
    outputText,
    finishReason,
    usage,
    toolResults,
    latencyMs,
    cost,
    error
  };

  const scores: ModelEvaluationScore[] = [];
  for (const scorer of suite.scorers) {
    try {
      scores.push(normalizeScorerResult(scorer.id, await scorer.score(context)));
    } catch (cause) {
      scores.push({ scorerId: scorer.id, error: normalizeError(cause) });
    }
  }
  const numericScores = scores.flatMap((score) => score.score === undefined ? [] : [score.score]);
  const scorerFailed = scores.some((score) => score.error !== undefined);

  return {
    caseName: testCase.name,
    candidateId: candidate.id,
    provider: candidate.model.provider,
    modelId: candidate.model.modelId,
    repetition,
    ok: error === undefined && !scorerFailed,
    outputText,
    finishReason,
    usage,
    toolCalls: toolResults.map((result) => result.toolName),
    latencyMs,
    cost: cost.totalCost === undefined && cost.usage === undefined ? undefined : cost,
    scores,
    meanScore: mean(numericScores),
    error,
    caseMetadata: testCase.metadata,
    candidateMetadata: candidate.metadata
  };
};

const summarizeCandidate = (
  candidate: ModelEvaluationCandidate,
  runs: ModelEvaluationRunResult[]
): ModelEvaluationCandidateSummary => {
  const successfulRuns = runs.filter((run) => run.ok).length;
  const scores = runs.flatMap((run) => run.meanScore === undefined ? [] : [run.meanScore]);
  const costs = runs.flatMap((run) => run.cost?.totalCost === undefined ? [] : [run.cost.totalCost]);
  const currencies = new Set(runs.map((run) => run.cost?.currency).filter((value): value is string => value !== undefined));
  return {
    candidateId: candidate.id,
    provider: candidate.model.provider,
    modelId: candidate.model.modelId,
    runs: runs.length,
    successfulRuns,
    failedRuns: runs.length - successfulRuns,
    errorRate: runs.length === 0 ? 0 : (runs.length - successfulRuns) / runs.length,
    meanScore: mean(scores),
    minScore: scores.length === 0 ? undefined : Math.min(...scores),
    maxScore: scores.length === 0 ? undefined : Math.max(...scores),
    p50LatencyMs: percentile(runs.map((run) => run.latencyMs), 0.5),
    p95LatencyMs: percentile(runs.map((run) => run.latencyMs), 0.95),
    totalCost: costs.length === 0 ? undefined : costs.reduce((sum, value) => sum + value, 0),
    meanCost: mean(costs),
    currency: currencies.size === 1 ? [...currencies][0] : undefined,
    usage: sumUsage(runs.map((run) => run.usage)),
    metadata: candidate.metadata
  };
};

export const evaluateModelEvaluationGate = (
  candidates: ModelEvaluationCandidateSummary[],
  thresholds: ModelEvaluationThresholds
): ModelEvaluationGateResult => {
  validateThresholds(thresholds);
  const checks: ModelEvaluationGateCheck[] = [];
  for (const candidate of candidates) {
    const addCheck = (
      code: ModelEvaluationGateCheckCode,
      actual: number | undefined,
      threshold: number,
      ok: boolean,
      label: string
    ) => checks.push({
      candidateId: candidate.candidateId,
      code,
      ok,
      actual,
      threshold,
      message: `${candidate.candidateId} ${label}: ${actual === undefined ? "unavailable" : actual}; threshold ${threshold}.`
    });

    if (thresholds.minMeanScore !== undefined) {
      addCheck(
        "min_mean_score",
        candidate.meanScore,
        thresholds.minMeanScore,
        candidate.meanScore !== undefined && candidate.meanScore >= thresholds.minMeanScore,
        "mean score"
      );
    }
    if (thresholds.maxTotalCost !== undefined) {
      addCheck(
        "max_total_cost",
        candidate.totalCost,
        thresholds.maxTotalCost,
        candidate.totalCost !== undefined && candidate.totalCost <= thresholds.maxTotalCost,
        "total cost"
      );
    }
    if (thresholds.maxP95LatencyMs !== undefined) {
      addCheck(
        "max_p95_latency_ms",
        candidate.p95LatencyMs,
        thresholds.maxP95LatencyMs,
        candidate.p95LatencyMs <= thresholds.maxP95LatencyMs,
        "p95 latency"
      );
    }
    if (thresholds.maxErrorRate !== undefined) {
      addCheck(
        "max_error_rate",
        candidate.errorRate,
        thresholds.maxErrorRate,
        candidate.errorRate <= thresholds.maxErrorRate,
        "error rate"
      );
    }
  }
  return {
    ok: checks.every((check) => check.ok),
    thresholds: { ...thresholds },
    checks
  };
};

export const runModelEvaluation = async (suite: ModelEvaluationSuite): Promise<ModelEvaluationReport> => {
  const { repetitions, maxConcurrency } = validateSuite(suite);
  const tasks = suite.candidates.flatMap((candidate) =>
    suite.cases.flatMap((testCase) =>
      Array.from({ length: repetitions }, (_, repetition) => ({
        candidate,
        testCase,
        repetition: repetition + 1
      }))
    )
  );
  const runs = new Array<ModelEvaluationRunResult>(tasks.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(maxConcurrency, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      const task = tasks[index]!;
      runs[index] = await evaluateSingleRun(task.testCase, task.candidate, task.repetition, suite);
    }
  });
  await Promise.all(workers);

  const candidates = suite.candidates.map((candidate) =>
    summarizeCandidate(candidate, runs.filter((run) => run.candidateId === candidate.id))
  );
  const gate = suite.thresholds ? evaluateModelEvaluationGate(candidates, suite.thresholds) : undefined;
  return {
    schemaVersion: MODEL_EVALUATION_REPORT_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    ok: runs.every((run) => run.ok) && (gate?.ok ?? true),
    repetitions,
    totalRuns: runs.length,
    cases: suite.cases.map((testCase) => testCase.name),
    candidates,
    runs,
    gate,
    metadata: suite.metadata
  };
};

export const compareModelEvaluationReports = (
  baseline: ModelEvaluationReport,
  target: ModelEvaluationReport
): ModelEvaluationComparison => {
  const ids = new Set([
    ...baseline.candidates.map((candidate) => candidate.candidateId),
    ...target.candidates.map((candidate) => candidate.candidateId)
  ]);
  return {
    baselineCreatedAt: baseline.createdAt,
    targetCreatedAt: target.createdAt,
    candidates: [...ids].sort().map((candidateId) => {
      const base = baseline.candidates.find((candidate) => candidate.candidateId === candidateId);
      const next = target.candidates.find((candidate) => candidate.candidateId === candidateId);
      return {
        candidateId,
        baseline: base,
        target: next,
        scoreDelta: base?.meanScore === undefined || next?.meanScore === undefined
          ? undefined
          : next.meanScore - base.meanScore,
        totalCostDelta: base?.totalCost === undefined || next?.totalCost === undefined
          ? undefined
          : next.totalCost - base.totalCost,
        p95LatencyDeltaMs: base === undefined || next === undefined
          ? undefined
          : next.p95LatencyMs - base.p95LatencyMs,
        errorRateDelta: base === undefined || next === undefined
          ? undefined
          : next.errorRate - base.errorRate
      };
    })
  };
};

const normalizedText = (value: string, options: { caseSensitive?: boolean; trim?: boolean }): string => {
  const trimmed = options.trim === false ? value : value.trim();
  return options.caseSensitive === false ? trimmed.toLocaleLowerCase() : trimmed;
};

const canonicalJson = (value: JsonValue): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
};

export const createExactMatchScorer = (options: {
  id?: string;
  caseSensitive?: boolean;
  trim?: boolean;
} = {}): ModelEvaluationScorer => ({
  id: options.id ?? "exact_match",
  score(context) {
    if (typeof context.testCase.reference !== "string") {
      throw new ValidationError(`Case ${JSON.stringify(context.testCase.name)} requires a string reference for exact match.`);
    }
    const actual = normalizedText(context.outputText ?? "", options);
    const expected = normalizedText(context.testCase.reference, options);
    return {
      score: actual === expected ? 1 : 0,
      feedback: actual === expected ? undefined : "Output did not exactly match the reference."
    };
  }
});

export const createContainsScorer = (options: {
  id?: string;
  caseSensitive?: boolean;
} = {}): ModelEvaluationScorer => ({
  id: options.id ?? "contains",
  score(context) {
    if (typeof context.testCase.reference !== "string") {
      throw new ValidationError(`Case ${JSON.stringify(context.testCase.name)} requires a string reference for contains scoring.`);
    }
    const actual = normalizedText(context.outputText ?? "", { caseSensitive: options.caseSensitive, trim: false });
    const expected = normalizedText(context.testCase.reference, { caseSensitive: options.caseSensitive, trim: false });
    return actual.includes(expected) ? 1 : 0;
  }
});

export const createRegexScorer = (options: {
  pattern: RegExp | ((testCase: ModelEvaluationCase) => RegExp);
  id?: string;
}): ModelEvaluationScorer => ({
  id: options.id ?? "regex",
  score(context) {
    const pattern = typeof options.pattern === "function" ? options.pattern(context.testCase) : options.pattern;
    pattern.lastIndex = 0;
    return pattern.test(context.outputText ?? "") ? 1 : 0;
  }
});

export const createJsonValueScorer = (options: { id?: string } = {}): ModelEvaluationScorer => ({
  id: options.id ?? "json_value",
  score(context) {
    if (context.testCase.reference === undefined) {
      throw new ValidationError(`Case ${JSON.stringify(context.testCase.name)} requires a JSON reference.`);
    }
    let actual: unknown;
    try {
      actual = JSON.parse(context.outputText ?? "");
    } catch {
      return { score: 0, feedback: "Output is not valid JSON." };
    }
    return canonicalJson(actual as JsonValue) === canonicalJson(context.testCase.reference)
      ? 1
      : { score: 0, feedback: "JSON output did not match the reference." };
  }
});

export const createJsonSchemaScorer = (schema: ZodTypeAny, options: { id?: string } = {}): ModelEvaluationScorer => ({
  id: options.id ?? "json_schema",
  score(context) {
    let actual: unknown;
    try {
      actual = JSON.parse(context.outputText ?? "");
    } catch {
      return { score: 0, feedback: "Output is not valid JSON." };
    }
    const result = schema.safeParse(actual);
    return result.success
      ? 1
      : { score: 0, feedback: result.error.issues.map((issue) => issue.message).join("; ") };
  }
});

export const createToolCallScorer = (options: { id?: string; requireExactOrder?: boolean } = {}): ModelEvaluationScorer => ({
  id: options.id ?? "tool_calls",
  score(context) {
    const expected = context.testCase.expectedToolCalls;
    if (!expected) {
      throw new ValidationError(`Case ${JSON.stringify(context.testCase.name)} requires expectedToolCalls.`);
    }
    const actual = context.toolResults.map((result) => result.toolName);
    const matches = options.requireExactOrder
      ? JSON.stringify(actual) === JSON.stringify(expected)
      : expected.every((name) => actual.includes(name)) && actual.every((name) => expected.includes(name));
    return matches ? 1 : { score: 0, feedback: `Expected tool calls ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.` };
  }
});

export const createEmbeddingSimilarityScorer = (options: {
  model: EmbeddingModel;
  id?: string;
  minimumSimilarity?: number;
}): ModelEvaluationScorer => {
  const cache = new Map<string, number[]>();
  return {
    id: options.id ?? "embedding_similarity",
    async score(context) {
      if (typeof context.testCase.reference !== "string") {
        throw new ValidationError(`Case ${JSON.stringify(context.testCase.name)} requires a string reference for embedding similarity.`);
      }
      const referenceKey = `${options.model.provider}\u0000${options.model.modelId}\u0000${context.testCase.name}\u0000${context.testCase.reference}`;
      let referenceEmbedding = cache.get(referenceKey);
      if (!referenceEmbedding) {
        referenceEmbedding = (await embed({ model: options.model, value: context.testCase.reference })).embeddings[0];
        if (!referenceEmbedding) {
          throw new ValidationError("Embedding model returned no reference embedding.");
        }
        cache.set(referenceKey, referenceEmbedding);
      }
      const outputEmbedding = (await embed({ model: options.model, value: context.outputText ?? "" })).embeddings[0];
      if (!outputEmbedding) {
        throw new ValidationError("Embedding model returned no output embedding.");
      }
      const similarity = Math.max(0, Math.min(1, cosineSimilarity(referenceEmbedding, outputEmbedding)));
      const minimum = options.minimumSimilarity;
      return {
        score: minimum === undefined || similarity >= minimum ? similarity : 0,
        metadata: { similarity }
      };
    }
  };
};

export const createModelJudgeScorer = (options: {
  model: LanguageModel;
  rubric: string;
  id?: string;
  maxTokens?: number;
}): ModelEvaluationScorer => ({
  id: options.id ?? "model_judge",
  async score(context) {
    const response = await generateText({
      model: options.model,
      maxTokens: options.maxTokens ?? 256,
      prompt: [
        "Evaluate the candidate output using the rubric.",
        "Return only JSON with this shape: {\"score\": number between 0 and 1, \"feedback\": string}.",
        `Rubric: ${options.rubric}`,
        `Input: ${context.testCase.prompt ?? JSON.stringify(context.testCase.messages)}`,
        `Reference: ${JSON.stringify(context.testCase.reference)}`,
        `Candidate output: ${context.outputText ?? ""}`
      ].join("\n")
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      throw new ValidationError("Model judge returned invalid JSON.");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ValidationError("Model judge returned an invalid result object.");
    }
    const score = (parsed as { score?: unknown }).score;
    assertFiniteRange(score, "Model judge score", 0, 1);
    const feedback = (parsed as { feedback?: unknown }).feedback;
    if (feedback !== undefined && typeof feedback !== "string") {
      throw new ValidationError("Model judge feedback must be a string.");
    }
    return { score, feedback };
  }
});
