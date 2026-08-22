# Comparative Model Evaluations

Comparative model evaluation is a Beta SDK surface for running the same cases against multiple `LanguageModel` candidates. It records quality scores, failures, token usage, estimated cost, p50/p95 latency, and optional fail-closed thresholds in one schema-versioned report.

Use the focused entrypoint when an evaluation worker does not need the rest of the SDK:

```ts
import {
  createExactMatchScorer,
  runModelEvaluation,
  type ModelEvaluationSuite,
} from "@zhivex-ai/sdk/evals";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const suite: ModelEvaluationSuite = {
  cases: [
    {
      name: "capital-of-argentina",
      prompt: "Return only the capital of Argentina.",
      reference: "Buenos Aires",
    },
  ],
  candidates: [
    { id: "fast", model: openai("gpt-5.6-luna") },
    { id: "balanced", model: openai("gpt-5.6-terra") },
  ],
  scorers: [createExactMatchScorer()],
  repetitions: 3,
  maxConcurrency: 4,
  thresholds: {
    minMeanScore: 0.9,
    maxErrorRate: 0,
    maxP95LatencyMs: 10_000,
  },
};

const report = await runModelEvaluation(suite);
if (!report.ok) process.exitCode = 1;
```

## Scorers

Built-in scorers cover exact/contains/regex text checks, JSON value or Zod schema validation, expected tool calls, embedding similarity, and model-as-judge evaluation. Custom scorers receive the case, candidate identity, output, finish reason, usage, tool results, latency, cost, and generation error. A scorer must return a finite score from `0` through `1`; scorer failures are recorded and make that run fail.

Model judges and embedding scorers execute additional model calls. Their own latency and cost are application-owned and are not folded into candidate generation cost. Keep judge credentials and policies in the local suite module.

## Pricing and Reproducibility

A candidate can provide explicit `pricing`, or the suite can provide a `ModelCatalog` used to resolve pricing by provider/model ID. Reports record aggregate token usage and estimated cost; catalog prices are estimates tied to their snapshot, not billing records.

For reproducible comparisons, pin model IDs, keep the suite module under source control, record the SDK/catalog version, use repetitions for variable providers, and archive the complete report. `compareModelEvaluationReports()` calculates score, cost, p95 latency, and error-rate deltas for matching candidate IDs.

## CLI

```bash
zhivex-ai eval run --module ./model-eval.mjs --export suite --out report.json
zhivex-ai eval compare --base baseline.json --target report.json --out comparison.json
```

`eval run` executes the models declared by the application-owned module and exits with code `1` when a run or threshold fails. `eval compare` is dry and only reads the two reports.
