import { describe, expect, it } from "vitest";

import {
  compareWorkflowEvaluationReports,
  createWorkflowEvaluationDiffReport,
  type WorkflowEvaluationReport
} from "../src/index.js";

const createReport = (cases: Array<{ name: string; ok: boolean; status?: "completed" | "failed"; failures?: string[] }>): WorkflowEvaluationReport => {
  const passed = cases.filter((testCase) => testCase.ok).length;
  const failed = cases.length - passed;
  return {
    ok: failed === 0,
    total: cases.length,
    passed,
    failed,
    passRate: cases.length ? passed / cases.length : 1,
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
      outputPreview: "{}",
      outputKeys: [],
      stepCount: 0,
      stepStatusCounts: {},
      timelineEventCounts: {}
    }))
  };
};

describe("workflow evaluation diff", () => {
  it("detects ok and pass-rate regressions", () => {
    const base = createReport([
      { name: "case-a", ok: true },
      { name: "case-b", ok: true }
    ]);
    const target = createReport([
      { name: "case-a", ok: true },
      { name: "case-b", ok: false, failures: ["Expected answer."] }
    ]);

    const diff = compareWorkflowEvaluationReports(base, target);

    expect(diff.ok).toBe(false);
    expect(diff.delta.passRate).toBe(-0.5);
    expect(diff.regressions).toEqual(expect.arrayContaining([
      "Evaluation changed from passing to failing.",
      "Case \"case-b\" regressed.",
      "Case \"case-b\" has 1 new failure(s)."
    ]));
  });

  it("detects new and resolved failures", () => {
    const base = createReport([
      { name: "case", ok: false, failures: ["Old failure."] }
    ]);
    const target = createReport([
      { name: "case", ok: false, failures: ["New failure."] }
    ]);

    const report = createWorkflowEvaluationDiffReport(compareWorkflowEvaluationReports(base, target));

    expect(report.cases[0]).toMatchObject({
      name: "case",
      status: "changed",
      newFailures: ["New failure."],
      resolvedFailures: ["Old failure."]
    });
    expect(report.summary).toMatchObject({
      changed: 1,
      newFailures: 1,
      resolvedFailures: 1
    });
  });

  it("detects added and removed cases", () => {
    const base = createReport([
      { name: "removed", ok: false, failures: ["Broken."] },
      { name: "same", ok: true }
    ]);
    const target = createReport([
      { name: "added", ok: true },
      { name: "same", ok: true }
    ]);

    const report = createWorkflowEvaluationDiffReport(compareWorkflowEvaluationReports(base, target));

    expect(report.cases).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "added", status: "added" }),
      expect.objectContaining({ name: "removed", status: "removed" }),
      expect.objectContaining({ name: "same", status: "unchanged" })
    ]));
    expect(report.summary).toMatchObject({
      added: 1,
      removed: 1,
      unchanged: 1
    });
  });

  it("exports workflow evaluation diff APIs from the public index", async () => {
    const api = await import("../src/index.js");

    expect(api.compareWorkflowEvaluationReports).toBeTypeOf("function");
    expect(api.createWorkflowEvaluationDiffReport).toBeTypeOf("function");
  });
});
