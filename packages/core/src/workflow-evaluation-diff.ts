import type { JsonValue } from "./types.js";
import type { WorkflowEvaluationReport, WorkflowEvaluationReportCase } from "./workflow-evaluation.js";
import type { WorkflowStatus } from "./workflow.js";

export type WorkflowEvaluationDiffCaseStatus = "added" | "removed" | "changed" | "unchanged";

export interface WorkflowEvaluationDiffCase {
  name: string;
  status: WorkflowEvaluationDiffCaseStatus;
  baseOk?: boolean;
  targetOk?: boolean;
  baseStatus?: WorkflowStatus;
  targetStatus?: WorkflowStatus;
  newFailures: string[];
  resolvedFailures: string[];
}

export interface WorkflowEvaluationDiffSummary {
  ok: boolean;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
}

export interface WorkflowEvaluationDiff {
  ok: boolean;
  base: WorkflowEvaluationDiffSummary;
  target: WorkflowEvaluationDiffSummary;
  delta: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
  };
  regressions: string[];
  improvements: string[];
  cases: WorkflowEvaluationDiffCase[];
  metadata?: Record<string, JsonValue>;
}

export interface WorkflowEvaluationDiffReport extends WorkflowEvaluationDiff {
  summary: {
    added: number;
    removed: number;
    changed: number;
    unchanged: number;
    newFailures: number;
    resolvedFailures: number;
  };
}

const summarizeReport = (report: WorkflowEvaluationReport): WorkflowEvaluationDiffSummary => ({
  ok: report.ok,
  total: report.total,
  passed: report.passed,
  failed: report.failed,
  passRate: report.passRate
});

const failuresFor = (testCase: WorkflowEvaluationReportCase | undefined): Set<string> =>
  new Set(testCase?.failures ?? []);

const difference = (left: Set<string>, right: Set<string>): string[] =>
  [...left].filter((value) => !right.has(value)).sort();

const reportCaseMap = (report: WorkflowEvaluationReport): Map<string, WorkflowEvaluationReportCase> =>
  new Map(report.cases.map((testCase) => [testCase.name, testCase]));

const caseChanged = (
  base: WorkflowEvaluationReportCase,
  target: WorkflowEvaluationReportCase,
  newFailures: string[],
  resolvedFailures: string[]
): boolean =>
  base.ok !== target.ok ||
  base.status !== target.status ||
  newFailures.length > 0 ||
  resolvedFailures.length > 0;

export const compareWorkflowEvaluationReports = (
  base: WorkflowEvaluationReport,
  target: WorkflowEvaluationReport,
  options: { metadata?: Record<string, JsonValue> } = {}
): WorkflowEvaluationDiff => {
  const baseByName = reportCaseMap(base);
  const targetByName = reportCaseMap(target);
  const names = [...new Set([...baseByName.keys(), ...targetByName.keys()])].sort();
  const cases: WorkflowEvaluationDiffCase[] = [];
  const regressions: string[] = [];
  const improvements: string[] = [];

  if (target.passRate < base.passRate) {
    regressions.push(`Pass rate decreased from ${base.passRate} to ${target.passRate}.`);
  } else if (target.passRate > base.passRate) {
    improvements.push(`Pass rate increased from ${base.passRate} to ${target.passRate}.`);
  }

  if (target.ok !== base.ok) {
    if (base.ok) {
      regressions.push("Evaluation changed from passing to failing.");
    } else {
      improvements.push("Evaluation changed from failing to passing.");
    }
  }

  for (const name of names) {
    const baseCase = baseByName.get(name);
    const targetCase = targetByName.get(name);
    const newFailures = difference(failuresFor(targetCase), failuresFor(baseCase));
    const resolvedFailures = difference(failuresFor(baseCase), failuresFor(targetCase));

    if (!baseCase && targetCase) {
      cases.push({
        name,
        status: "added",
        targetOk: targetCase.ok,
        targetStatus: targetCase.status,
        newFailures,
        resolvedFailures
      });
      if (!targetCase.ok || newFailures.length > 0) {
        regressions.push(`Failing case "${name}" was added.`);
      }
      continue;
    }

    if (baseCase && !targetCase) {
      cases.push({
        name,
        status: "removed",
        baseOk: baseCase.ok,
        baseStatus: baseCase.status,
        newFailures,
        resolvedFailures
      });
      if (!baseCase.ok || resolvedFailures.length > 0) {
        improvements.push(`Failing case "${name}" was removed.`);
      }
      continue;
    }

    if (!baseCase || !targetCase) {
      continue;
    }

    const status: WorkflowEvaluationDiffCaseStatus = caseChanged(baseCase, targetCase, newFailures, resolvedFailures)
      ? "changed"
      : "unchanged";
    cases.push({
      name,
      status,
      baseOk: baseCase.ok,
      targetOk: targetCase.ok,
      baseStatus: baseCase.status,
      targetStatus: targetCase.status,
      newFailures,
      resolvedFailures
    });

    if (baseCase.ok && !targetCase.ok) {
      regressions.push(`Case "${name}" regressed.`);
    } else if (!baseCase.ok && targetCase.ok) {
      improvements.push(`Case "${name}" recovered.`);
    }
    if (newFailures.length > 0) {
      regressions.push(`Case "${name}" has ${newFailures.length} new failure(s).`);
    }
    if (resolvedFailures.length > 0) {
      improvements.push(`Case "${name}" resolved ${resolvedFailures.length} failure(s).`);
    }
    if (baseCase.status !== targetCase.status) {
      const message = `Case "${name}" status changed from "${baseCase.status}" to "${targetCase.status}".`;
      if (targetCase.ok || !baseCase.ok) {
        improvements.push(message);
      } else {
        regressions.push(message);
      }
    }
  }

  return {
    ok: regressions.length === 0,
    base: summarizeReport(base),
    target: summarizeReport(target),
    delta: {
      total: target.total - base.total,
      passed: target.passed - base.passed,
      failed: target.failed - base.failed,
      passRate: target.passRate - base.passRate
    },
    regressions,
    improvements,
    cases,
    metadata: options.metadata
  };
};

export const createWorkflowEvaluationDiffReport = (
  diff: WorkflowEvaluationDiff
): WorkflowEvaluationDiffReport => ({
  ...diff,
  cases: diff.cases.map((testCase) => ({
    ...testCase,
    newFailures: [...testCase.newFailures],
    resolvedFailures: [...testCase.resolvedFailures]
  })),
  regressions: [...diff.regressions],
  improvements: [...diff.improvements],
  summary: {
    added: diff.cases.filter((testCase) => testCase.status === "added").length,
    removed: diff.cases.filter((testCase) => testCase.status === "removed").length,
    changed: diff.cases.filter((testCase) => testCase.status === "changed").length,
    unchanged: diff.cases.filter((testCase) => testCase.status === "unchanged").length,
    newFailures: diff.cases.reduce((total, testCase) => total + testCase.newFailures.length, 0),
    resolvedFailures: diff.cases.reduce((total, testCase) => total + testCase.resolvedFailures.length, 0)
  }
});
