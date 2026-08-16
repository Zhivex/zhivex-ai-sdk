import { describe, expect, it } from "vitest";

import {
  WORKFLOW_EVALUATION_BASELINE_SCHEMA_VERSION,
  WORKFLOW_EVALUATION_GATE_SCHEMA_VERSION,
  ValidationError,
  createWorkflowEvaluationBaseline,
  evaluateWorkflowEvaluationGate,
  normalizeWorkflowEvaluationBaseline,
  type WorkflowEvaluationReport
} from "../src/index.js";

type ReportCase = {
  name: string;
  ok: boolean;
  status?: "completed" | "failed";
  failures?: string[];
  durationMs?: number;
  outputPreview?: string;
};

const createReport = (
  cases: ReportCase[],
  options: { ok?: boolean; judgeScore?: number } = {}
): WorkflowEvaluationReport => {
  const passed = cases.filter((testCase) => testCase.ok).length;
  const failed = cases.length - passed;
  return {
    ok: options.ok ?? failed === 0,
    total: cases.length,
    passed,
    failed,
    passRate: cases.length === 0 ? 1 : passed / cases.length,
    statusCounts: {},
    stepCount: 0,
    stepStatusCounts: {},
    timelineEventCounts: {},
    failures: cases
      .filter((testCase) => testCase.failures?.length)
      .map((testCase) => ({ name: testCase.name, failures: testCase.failures ?? [] })),
    cases: cases.map((testCase) => ({
      name: testCase.name,
      ok: testCase.ok,
      status: testCase.status ?? (testCase.ok ? "completed" : "failed"),
      failures: testCase.failures ?? [],
      outputPreview: testCase.outputPreview ?? "{}",
      outputKeys: [],
      stepCount: 0,
      stepStatusCounts: {},
      timelineEventCounts: {},
      durationMs: testCase.durationMs
    })),
    judge: options.judgeScore === undefined ? undefined : { score: options.judgeScore }
  };
};

describe("workflow evaluation baseline gates", () => {
  it("creates a canonical versioned baseline without volatile report fields", () => {
    const baseline = createWorkflowEvaluationBaseline(
      createReport([
        {
          name: "zeta",
          ok: false,
          failures: ["second", "first"],
          durationMs: 9_999,
          outputPreview: "volatile output"
        },
        { name: "alpha", ok: true, durationMs: 1 }
      ], { judgeScore: 0.75 }),
      {
        name: "reviewed-v1",
        metadata: { z: 1, a: { y: 2, x: 1 } }
      }
    );

    expect(baseline).toEqual({
      schemaVersion: WORKFLOW_EVALUATION_BASELINE_SCHEMA_VERSION,
      name: "reviewed-v1",
      reportOk: false,
      total: 2,
      passed: 1,
      failed: 1,
      passRate: 0.5,
      judgeScore: 0.75,
      cases: [
        { name: "alpha", ok: true, status: "completed", failures: [] },
        { name: "zeta", ok: false, status: "failed", failures: ["first", "second"] }
      ],
      metadata: { a: { x: 1, y: 2 }, z: 1 }
    });
    expect(JSON.stringify(baseline)).not.toContain("durationMs");
    expect(JSON.stringify(baseline)).not.toContain("volatile output");
    expect(createWorkflowEvaluationBaseline(
      createReport([
        { name: "alpha", ok: true, durationMs: 88 },
        { name: "zeta", ok: false, failures: ["first", "second"], durationMs: 22 }
      ], { judgeScore: 0.75 }),
      { name: "reviewed-v1", metadata: { a: { x: 1, y: 2 }, z: 1 } }
    )).toEqual(baseline);
  });

  it("passes unchanged and improved candidate reports with safe defaults", () => {
    const baseline = createWorkflowEvaluationBaseline(createReport([
      { name: "known-failure", ok: false, failures: ["known"] },
      { name: "passing", ok: true }
    ], { ok: false }), { name: "suite-v1" });
    const candidate = createReport([
      { name: "known-failure", ok: true },
      { name: "passing", ok: true },
      { name: "new-passing", ok: true }
    ]);

    const gate = evaluateWorkflowEvaluationGate(baseline, candidate);

    expect(gate).toMatchObject({
      schemaVersion: WORKFLOW_EVALUATION_GATE_SCHEMA_VERSION,
      ok: true,
      delta: { passed: 2, failed: -1, passRate: 0.5 },
      summary: {
        addedCases: 1,
        removedCases: 0,
        regressedCases: 0,
        newFailures: 0,
        resolvedFailures: 1
      },
      issues: []
    });
    expect(JSON.parse(JSON.stringify(gate))).toEqual(gate);
  });

  it("fails deterministically for pass-rate, case, failure, and removal regressions", () => {
    const baseline = createWorkflowEvaluationBaseline(createReport([
      { name: "removed", ok: true },
      { name: "regressed", ok: true }
    ]), { name: "suite-v1" });
    const candidate = createReport([
      { name: "regressed", ok: false, failures: ["new failure"] },
      { name: "added-failure", ok: false, failures: ["added failure"] }
    ]);

    const gate = evaluateWorkflowEvaluationGate(baseline, candidate);

    expect(gate.ok).toBe(false);
    expect(gate.summary).toMatchObject({
      addedCases: 1,
      removedCases: 1,
      regressedCases: 2,
      newFailures: 2
    });
    expect(gate.issues.map((issue) => issue.code)).toEqual([
      "candidate_ok",
      "max_pass_rate_drop",
      "max_failed_cases",
      "max_regressed_cases",
      "max_new_failures",
      "max_removed_cases"
    ]);
    expect(gate.cases).toEqual([
      expect.objectContaining({ name: "added-failure", status: "added" }),
      expect.objectContaining({ name: "regressed", status: "changed" }),
      expect.objectContaining({ name: "removed", status: "removed" })
    ]);
  });

  it("supports explicit absolute, relative, count, and verdict tolerances", () => {
    const baseline = createWorkflowEvaluationBaseline(createReport([
      { name: "a", ok: true },
      { name: "b", ok: true }
    ]), { name: "suite-v1" });
    const candidate = createReport([
      { name: "a", ok: false, failures: ["known"] },
      { name: "b", ok: true }
    ]);

    const gate = evaluateWorkflowEvaluationGate(baseline, candidate, {
      thresholds: {
        minPassRate: 0.5,
        maxPassRateDrop: 0.5,
        maxFailedCases: 1,
        maxRegressedCases: 1,
        maxNewFailures: 1,
        maxRemovedCases: 0,
        requireCandidateOk: false
      }
    });

    expect(gate.ok).toBe(true);
    expect(gate.issues).toEqual([]);
    expect(gate.thresholds).toMatchObject({
      minPassRate: 0.5,
      maxPassRateDrop: 0.5,
      maxFailedCases: 1,
      maxRegressedCases: 1,
      maxNewFailures: 1,
      requireCandidateOk: false
    });
  });

  it("enforces absolute and baseline-relative judge score thresholds", () => {
    const baseline = createWorkflowEvaluationBaseline(
      createReport([{ name: "case", ok: true }], { judgeScore: 0.9 }),
      { name: "judged-v1" }
    );
    const degraded = evaluateWorkflowEvaluationGate(
      baseline,
      createReport([{ name: "case", ok: true }], { judgeScore: 0.7 }),
      { thresholds: { minJudgeScore: 0.8, maxJudgeScoreDrop: 0.1 } }
    );
    const missing = evaluateWorkflowEvaluationGate(
      baseline,
      createReport([{ name: "case", ok: true }]),
      { thresholds: { minJudgeScore: 0.8 } }
    );

    expect(degraded.issues.map((issue) => issue.code)).toEqual([
      "min_judge_score",
      "max_judge_score_drop"
    ]);
    expect(missing.issues.map((issue) => issue.code)).toEqual([
      "min_judge_score",
      "max_judge_score_drop"
    ]);
    expect(missing.issues.every((issue) => issue.actual === null)).toBe(true);
  });

  it("rejects unsupported, inconsistent, and unsafe baseline inputs", () => {
    const report = createReport([{ name: "case", ok: true }]);
    const baseline = createWorkflowEvaluationBaseline(report, { name: "suite-v1" });

    expect(() => normalizeWorkflowEvaluationBaseline({ ...baseline, schemaVersion: 2 })).toThrow(
      "Unsupported workflow evaluation baseline schema version 2."
    );
    expect(() => normalizeWorkflowEvaluationBaseline({ ...baseline, schemaVersion: 2 })).toThrow(
      ValidationError
    );
    expect(() => normalizeWorkflowEvaluationBaseline({ ...baseline, passRate: 0 })).toThrow(
      "baseline.passRate must equal passed divided by total."
    );
    expect(() => createWorkflowEvaluationBaseline({
      ...report,
      cases: [report.cases[0]!, report.cases[0]!],
      total: 2,
      passed: 2,
      passRate: 1
    }, { name: "suite-v1" })).toThrow('report.cases contains duplicate case name "case".');
    expect(() => evaluateWorkflowEvaluationGate(baseline, report, {
      thresholds: { maxFailedCases: -1 }
    })).toThrow("thresholds.maxFailedCases must be a non-negative integer.");
    expect(() => evaluateWorkflowEvaluationGate(baseline, {
      ...report,
      total: 2
    })).toThrow("candidate.passed plus candidate.failed must equal candidate.total.");
  });

  it("exports baseline gate APIs from the public index", async () => {
    const api = await import("../src/index.js");

    expect(api.WORKFLOW_EVALUATION_BASELINE_SCHEMA_VERSION).toBe(1);
    expect(api.WORKFLOW_EVALUATION_GATE_SCHEMA_VERSION).toBe(1);
    expect(api.createWorkflowEvaluationBaseline).toBeTypeOf("function");
    expect(api.evaluateWorkflowEvaluationGate).toBeTypeOf("function");
    expect(api.normalizeWorkflowEvaluationBaseline).toBeTypeOf("function");
  });
});
