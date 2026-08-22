import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  compareModelEvaluationReports,
  createContainsScorer,
  createEmbeddingSimilarityScorer,
  createExactMatchScorer,
  createJsonSchemaScorer,
  createJsonValueScorer,
  createModelCatalog,
  createModelJudgeScorer,
  createRegexScorer,
  createTextMessage,
  createToolCallScorer,
  evaluateModelEvaluationGate,
  runModelEvaluation,
  type EmbeddingModel,
  type LanguageModel,
  type ModelCapabilities,
  type ToolExecutionResult
} from "../src/index.js";

const capabilities: ModelCapabilities = {
  streaming: false,
  tools: false,
  structuredOutput: true,
  jsonMode: true,
  toolChoice: false,
  parallelToolCalls: false,
  vision: false,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
  reasoning: false,
  webSearch: false
};

const createEvaluationModel = (options: {
  provider?: string;
  modelId: string;
  transform: (prompt: string) => string;
  delayMs?: number;
}): LanguageModel => ({
  provider: options.provider ?? "test",
  modelId: options.modelId,
  capabilities,
  async generate(input) {
    if (options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    const prompt = input.messages
      .flatMap((message) => message.parts)
      .filter((part): part is Extract<(typeof input.messages)[number]["parts"][number], { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("");
    const text = options.transform(prompt);
    return {
      messages: [createTextMessage("assistant", text)],
      text,
      finishReason: "stop",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15
      }
    };
  }
});

describe("comparative model evaluations", () => {
  it("runs a bounded candidate matrix with repetitions, costs, summaries, and gates", async () => {
    const catalog = createModelCatalog([
      {
        provider: "test",
        modelId: "accurate",
        inputCostPer1kTokens: 1,
        outputCostPer1kTokens: 2
      },
      {
        provider: "test",
        modelId: "inaccurate",
        costPer1kTokens: 1
      }
    ], {
      snapshotVersion: "test-v1",
      policy: { data: "pinned", updates: "never" },
      pricing: { version: "test-v1", currency: "USD", unit: "per_1k_tokens" }
    });

    const report = await runModelEvaluation({
      cases: [
        { name: "alpha", prompt: "alpha", reference: "answer:alpha" },
        { name: "beta", prompt: "beta", reference: "answer:beta" }
      ],
      candidates: [
        {
          id: "accurate",
          model: createEvaluationModel({ modelId: "accurate", transform: (prompt) => `answer:${prompt}` })
        },
        {
          id: "inaccurate",
          model: createEvaluationModel({ modelId: "inaccurate", transform: () => "wrong" })
        }
      ],
      scorers: [createExactMatchScorer()],
      repetitions: 2,
      maxConcurrency: 2,
      catalog,
      thresholds: {
        minMeanScore: 0.5,
        maxErrorRate: 0,
        maxP95LatencyMs: 1_000,
        maxTotalCost: 1
      },
      metadata: { suite: "portable-chat" }
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      ok: false,
      repetitions: 2,
      totalRuns: 8,
      cases: ["alpha", "beta"],
      metadata: { suite: "portable-chat" }
    });
    expect(report.candidates).toHaveLength(2);
    expect(report.candidates[0]).toMatchObject({
      candidateId: "accurate",
      runs: 4,
      successfulRuns: 4,
      errorRate: 0,
      meanScore: 1,
      currency: "USD",
      usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 }
    });
    expect(report.candidates[0]!.totalCost).toBeCloseTo(0.08);
    expect(report.candidates[1]).toMatchObject({ candidateId: "inaccurate", meanScore: 0 });
    expect(report.gate?.checks.some((check) => check.candidateId === "inaccurate" && !check.ok)).toBe(true);
  });

  it("captures generation and scorer errors without abandoning the matrix", async () => {
    const failingModel: LanguageModel = {
      provider: "test",
      modelId: "failing",
      capabilities,
      async generate() {
        throw new Error("provider unavailable");
      }
    };
    const report = await runModelEvaluation({
      cases: [{ name: "failure", prompt: "hello", reference: "hello" }],
      candidates: [{ id: "failing", model: failingModel }],
      scorers: [
        createContainsScorer(),
        {
          id: "broken_scorer",
          score() {
            throw new Error("scorer unavailable");
          }
        }
      ]
    });

    expect(report.ok).toBe(false);
    expect(report.runs[0]).toMatchObject({
      ok: false,
      error: "provider unavailable",
      scores: [
        { scorerId: "contains", score: 0 },
        { scorerId: "broken_scorer", error: "scorer unavailable" }
      ]
    });
    expect(report.candidates[0]).toMatchObject({ failedRuns: 1, errorRate: 1 });
  });

  it("fails cost gates closed when any run cannot be priced", async () => {
    let invocation = 0;
    const model: LanguageModel = {
      provider: "test",
      modelId: "partial-usage",
      capabilities,
      async generate() {
        invocation += 1;
        return {
          messages: [createTextMessage("assistant", "ok")],
          text: "ok",
          finishReason: "stop",
          usage: invocation === 1
            ? { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
            : undefined
        };
      }
    };
    const report = await runModelEvaluation({
      cases: [{ name: "partial-cost", prompt: "ok", reference: "ok" }],
      candidates: [{ id: "partial-usage", model, pricing: { costPer1kTokens: 1, currency: "USD" } }],
      scorers: [createExactMatchScorer()],
      repetitions: 2,
      maxConcurrency: 1,
      thresholds: { maxTotalCost: 1 }
    });

    expect(report.runs[0]?.cost?.totalCost).toBeCloseTo(0.015);
    expect(report.runs[1]?.cost?.totalCost).toBeUndefined();
    expect(report.candidates[0]).toMatchObject({ totalCost: undefined, meanCost: undefined, currency: undefined });
    expect(report.gate).toMatchObject({
      ok: false,
      checks: [{ code: "max_total_cost", ok: false, actual: undefined }]
    });
    expect(report.ok).toBe(false);
  });

  it("provides JSON, schema, regex, embedding, and model-judge scorers", async () => {
    const embeddingModel: EmbeddingModel = {
      provider: "test",
      modelId: "embedding",
      capabilities: { ...capabilities, embeddings: true },
      async embed(input) {
        return {
          embeddings: input.values.map((value) => String(value).includes("approved") ? [1, 0] : [0, 1])
        };
      }
    };
    const judge = createEvaluationModel({
      modelId: "judge",
      transform: () => JSON.stringify({ score: 0.75, feedback: "mostly correct" })
    });
    const jsonModel = createEvaluationModel({
      modelId: "json",
      transform: () => JSON.stringify({ details: { count: 1 }, status: "approved" })
    });

    const report = await runModelEvaluation({
      cases: [{
        name: "structured",
        prompt: "return approved",
        reference: { status: "approved", details: { count: 1 } }
      }],
      candidates: [{ id: "json", model: jsonModel }],
      scorers: [
        createJsonValueScorer(),
        createJsonSchemaScorer(z.object({ status: z.literal("approved") })),
        createRegexScorer({ pattern: /approved/u }),
        createModelJudgeScorer({ model: judge, rubric: "Prefer approved outputs." })
      ]
    });

    expect(report.runs[0]?.scores.map((score) => score.score)).toEqual([1, 1, 1, 0.75]);

    const semantic = createEmbeddingSimilarityScorer({ model: embeddingModel });
    await expect(semantic.score({
      testCase: { name: "semantic", prompt: "x", reference: "approved reference" },
      candidate: { id: "candidate", provider: "test", modelId: "model" },
      repetition: 1,
      outputText: "approved output",
      toolResults: [],
      latencyMs: 1
    })).resolves.toMatchObject({ score: 1 });
  });

  it("compares unordered tool calls as multisets", async () => {
    const result = (toolName: string, index: number): ToolExecutionResult => ({
      toolCallId: `${toolName}-${index}`,
      toolName,
      isError: false
    });
    const context = (expectedToolCalls: string[], actualToolCalls: string[]) => ({
      testCase: { name: "tools", prompt: "use tools", expectedToolCalls },
      candidate: { id: "candidate", provider: "test", modelId: "model" },
      repetition: 1,
      toolResults: actualToolCalls.map(result),
      latencyMs: 1
    });
    const scorer = createToolCallScorer();

    await expect(Promise.resolve(scorer.score(context(["search", "search"], ["search"])))).resolves.toMatchObject({ score: 0 });
    await expect(Promise.resolve(scorer.score(context(["search"], ["search", "search"])))).resolves.toMatchObject({ score: 0 });
    await expect(Promise.resolve(scorer.score(
      context(["search", "lookup", "search"], ["lookup", "search", "search"])
    ))).resolves.toBe(1);
  });

  it("deduplicates concurrent reference embedding requests", async () => {
    let totalRequests = 0;
    let referenceRequests = 0;
    const embeddingModel: EmbeddingModel = {
      provider: "test",
      modelId: "embedding",
      capabilities: { ...capabilities, embeddings: true },
      async embed(input) {
        totalRequests += 1;
        if (input.values[0] === "shared reference") {
          referenceRequests += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return { embeddings: input.values.map(() => [1, 0]) };
      }
    };
    const scorer = createEmbeddingSimilarityScorer({ model: embeddingModel });
    const context = (candidateId: string, outputText: string) => ({
      testCase: { name: "concurrent", prompt: "x", reference: "shared reference" },
      candidate: { id: candidateId, provider: "test", modelId: candidateId },
      repetition: 1,
      outputText,
      toolResults: [],
      latencyMs: 1
    });

    await expect(Promise.all([
      scorer.score(context("first", "first output")),
      scorer.score(context("second", "second output"))
    ])).resolves.toHaveLength(2);
    expect(referenceRequests).toBe(1);
    expect(totalRequests).toBe(3);
  });

  it("compares reports and validates fail-closed unavailable cost thresholds", () => {
    const candidate = {
      candidateId: "model",
      provider: "test",
      modelId: "model",
      runs: 1,
      successfulRuns: 1,
      failedRuns: 0,
      errorRate: 0,
      meanScore: 0.5,
      minScore: 0.5,
      maxScore: 0.5,
      p50LatencyMs: 20,
      p95LatencyMs: 20
    };
    const baseline = {
      schemaVersion: 1 as const,
      createdAt: "2026-08-20T00:00:00.000Z",
      ok: true,
      repetitions: 1,
      totalRuns: 1,
      cases: ["case"],
      candidates: [candidate],
      runs: []
    };
    const target = {
      ...baseline,
      createdAt: "2026-08-21T00:00:00.000Z",
      candidates: [{ ...candidate, meanScore: 0.75, p95LatencyMs: 15 }]
    };

    expect(compareModelEvaluationReports(baseline, target).candidates[0]).toMatchObject({
      scoreDelta: 0.25,
      p95LatencyDeltaMs: -5,
      errorRateDelta: 0
    });
    expect(evaluateModelEvaluationGate([candidate], { maxTotalCost: 1 })).toMatchObject({
      ok: false,
      checks: [{ code: "max_total_cost", ok: false, actual: undefined }]
    });
  });

  it("rejects ambiguous inputs, duplicate identifiers, and unsafe execution bounds", async () => {
    const model = createEvaluationModel({ modelId: "model", transform: (prompt) => prompt });
    await expect(runModelEvaluation({
      cases: [{ name: "bad", prompt: "x", messages: [] }],
      candidates: [{ id: "model", model }],
      scorers: [createExactMatchScorer()]
    })).rejects.toThrow("exactly one of prompt or messages");
    await expect(runModelEvaluation({
      cases: [{ name: "case", prompt: "x" }],
      candidates: [{ id: "model", model }, { id: "model", model }],
      scorers: [createExactMatchScorer()]
    })).rejects.toThrow("Duplicate model evaluation candidate");
    await expect(runModelEvaluation({
      cases: [{ name: "case", prompt: "x" }],
      candidates: [{ id: "model", model }],
      scorers: [createExactMatchScorer()],
      maxConcurrency: 0
    })).rejects.toThrow("maxConcurrency");
  });
});
