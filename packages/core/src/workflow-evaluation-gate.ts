import { ValidationError } from "./errors.js";
import type { JsonValue } from "./types.js";
import type { WorkflowEvaluationReport } from "./workflow-evaluation.js";
import type { WorkflowStatus } from "./workflow.js";

export const WORKFLOW_EVALUATION_BASELINE_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_EVALUATION_GATE_SCHEMA_VERSION = 1 as const;

export interface WorkflowEvaluationBaselineCase {
  name: string;
  ok: boolean;
  status: WorkflowStatus;
  failures: string[];
}

/**
 * A versioned, deterministic subset of a workflow evaluation report.
 * Runtime-specific previews, timestamps, and durations are intentionally omitted.
 */
export interface WorkflowEvaluationBaseline {
  schemaVersion: typeof WORKFLOW_EVALUATION_BASELINE_SCHEMA_VERSION;
  name: string;
  reportOk: boolean;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  judgeScore?: number;
  cases: WorkflowEvaluationBaselineCase[];
  metadata?: Record<string, JsonValue>;
}

export interface WorkflowEvaluationGateThresholds {
  /** Absolute pass-rate floor. Defaults to 0. */
  minPassRate?: number;
  /** Maximum pass-rate decrease relative to the baseline. Defaults to 0. */
  maxPassRateDrop?: number;
  /** Maximum total failing candidate cases. Defaults to the baseline failed count. */
  maxFailedCases?: number;
  /** Maximum cases that changed from passing to failing, including new failing cases. Defaults to 0. */
  maxRegressedCases?: number;
  /** Maximum newly introduced failure messages. Defaults to 0. */
  maxNewFailures?: number;
  /** Maximum cases removed from the candidate report. Defaults to 0. */
  maxRemovedCases?: number;
  /** Require the candidate's overall report verdict to pass. Defaults to the baseline verdict. */
  requireCandidateOk?: boolean;
  /** Absolute judge-score floor. Omitted unless configured. */
  minJudgeScore?: number;
  /** Maximum judge-score decrease relative to the baseline. Defaults to 0 when the baseline has a judge score. */
  maxJudgeScoreDrop?: number;
}

export interface WorkflowEvaluationGateResolvedThresholds {
  minPassRate: number;
  maxPassRateDrop: number;
  maxFailedCases: number;
  maxRegressedCases: number;
  maxNewFailures: number;
  maxRemovedCases: number;
  requireCandidateOk: boolean;
  minJudgeScore?: number;
  maxJudgeScoreDrop?: number;
}

export type WorkflowEvaluationGateCheckCode =
  | "candidate_ok"
  | "min_pass_rate"
  | "max_pass_rate_drop"
  | "max_failed_cases"
  | "max_regressed_cases"
  | "max_new_failures"
  | "max_removed_cases"
  | "min_judge_score"
  | "max_judge_score_drop";

export interface WorkflowEvaluationGateCheck {
  code: WorkflowEvaluationGateCheckCode;
  ok: boolean;
  actual: number | boolean | null;
  limit: number | boolean;
  baseline?: number | boolean;
  message: string;
}

export interface WorkflowEvaluationGateCaseDiff {
  name: string;
  status: "added" | "removed" | "changed" | "unchanged";
  baselineOk?: boolean;
  candidateOk?: boolean;
  baselineStatus?: WorkflowStatus;
  candidateStatus?: WorkflowStatus;
  newFailures: string[];
  resolvedFailures: string[];
}

export interface WorkflowEvaluationGateResult {
  schemaVersion: typeof WORKFLOW_EVALUATION_GATE_SCHEMA_VERSION;
  ok: boolean;
  baseline: {
    schemaVersion: typeof WORKFLOW_EVALUATION_BASELINE_SCHEMA_VERSION;
    name: string;
    reportOk: boolean;
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    judgeScore?: number;
  };
  candidate: {
    ok: boolean;
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    judgeScore?: number;
  };
  delta: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    judgeScore?: number;
  };
  summary: {
    addedCases: number;
    removedCases: number;
    changedCases: number;
    unchangedCases: number;
    regressedCases: number;
    newFailures: number;
    resolvedFailures: number;
  };
  thresholds: WorkflowEvaluationGateResolvedThresholds;
  checks: WorkflowEvaluationGateCheck[];
  issues: WorkflowEvaluationGateCheck[];
  cases: WorkflowEvaluationGateCaseDiff[];
  metadata?: Record<string, JsonValue>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertBoolean = (value: unknown, label: string): boolean => {
  if (typeof value !== "boolean") {
    throw new ValidationError(`${label} must be a boolean.`);
  }
  return value;
};

const assertNonEmptyString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${label} must be a non-empty string.`);
  }
  return value;
};

const assertInteger = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${label} must be a non-negative integer.`);
  }
  return value;
};

const assertRate = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ValidationError(`${label} must be a finite number between 0 and 1.`);
  }
  return value;
};

const assertStringArray = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ValidationError(`${label} must be an array of strings.`);
  }
  return [...value].sort();
};

const workflowStatuses = new Set<WorkflowStatus>([
  "running",
  "completed",
  "waiting_approval",
  "failed"
]);

const assertWorkflowStatus = (value: unknown, label: string): WorkflowStatus => {
  const status = assertNonEmptyString(value, label) as WorkflowStatus;
  if (!workflowStatuses.has(status)) {
    throw new ValidationError(`${label} must be a valid workflow status.`);
  }
  return status;
};

const canonicalizeJsonValue = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalizeJsonValue(entry as JsonValue)])
    );
  }
  return value;
};

const canonicalizeMetadata = (
  metadata: Record<string, JsonValue> | undefined
): Record<string, JsonValue> | undefined =>
  metadata
    ? canonicalizeJsonValue(metadata) as Record<string, JsonValue>
    : undefined;

const expectedPassRate = (passed: number, total: number): number => total === 0 ? 1 : passed / total;

const validateSummary = (summary: {
  total: unknown;
  passed: unknown;
  failed: unknown;
  passRate: unknown;
}, label: string) => {
  const total = assertInteger(summary.total, `${label}.total`);
  const passed = assertInteger(summary.passed, `${label}.passed`);
  const failed = assertInteger(summary.failed, `${label}.failed`);
  const passRate = assertRate(summary.passRate, `${label}.passRate`);
  if (passed + failed !== total) {
    throw new ValidationError(`${label}.passed plus ${label}.failed must equal ${label}.total.`);
  }
  if (Math.abs(passRate - expectedPassRate(passed, total)) > Number.EPSILON * 4) {
    throw new ValidationError(`${label}.passRate must equal passed divided by total.`);
  }
  return { total, passed, failed, passRate };
};

const validateReportCases = (
  cases: unknown,
  label: string
): WorkflowEvaluationBaselineCase[] => {
  if (!Array.isArray(cases)) {
    throw new ValidationError(`${label} must be an array.`);
  }
  const names = new Set<string>();
  const normalized = cases.map((value, index): WorkflowEvaluationBaselineCase => {
    if (!isRecord(value)) {
      throw new ValidationError(`${label}[${index}] must be an object.`);
    }
    const name = assertNonEmptyString(value.name, `${label}[${index}].name`);
    if (names.has(name)) {
      throw new ValidationError(`${label} contains duplicate case name "${name}".`);
    }
    names.add(name);
    return {
      name,
      ok: assertBoolean(value.ok, `${label}[${index}].ok`),
      status: assertWorkflowStatus(value.status, `${label}[${index}].status`),
      failures: assertStringArray(value.failures, `${label}[${index}].failures`)
    };
  });
  return normalized.sort((left, right) => left.name.localeCompare(right.name));
};

const normalizeReport = (report: WorkflowEvaluationReport, label: string) => {
  if (!isRecord(report)) {
    throw new ValidationError(`${label} must be an object.`);
  }
  const summary = validateSummary(report, label);
  const cases = validateReportCases(report.cases, `${label}.cases`);
  if (cases.length !== summary.total) {
    throw new ValidationError(`${label}.cases length must equal ${label}.total.`);
  }
  const casePassed = cases.filter((testCase) => testCase.ok).length;
  if (casePassed !== summary.passed) {
    throw new ValidationError(`${label}.passed must match the number of passing cases.`);
  }
  const judgeScore = report.judge === undefined
    ? undefined
    : assertRate(report.judge.score, `${label}.judge.score`);
  return {
    ok: assertBoolean(report.ok, `${label}.ok`),
    ...summary,
    judgeScore,
    cases
  };
};

export const createWorkflowEvaluationBaseline = (
  report: WorkflowEvaluationReport,
  options: {
    name: string;
    metadata?: Record<string, JsonValue>;
  }
): WorkflowEvaluationBaseline => {
  const normalized = normalizeReport(report, "report");
  return {
    schemaVersion: WORKFLOW_EVALUATION_BASELINE_SCHEMA_VERSION,
    name: assertNonEmptyString(options.name, "options.name"),
    reportOk: normalized.ok,
    total: normalized.total,
    passed: normalized.passed,
    failed: normalized.failed,
    passRate: normalized.passRate,
    judgeScore: normalized.judgeScore,
    cases: normalized.cases,
    metadata: canonicalizeMetadata(options.metadata)
  };
};

export const normalizeWorkflowEvaluationBaseline = (value: unknown): WorkflowEvaluationBaseline => {
  if (!isRecord(value)) {
    throw new ValidationError("Workflow evaluation baseline must be an object.");
  }
  if (value.schemaVersion !== WORKFLOW_EVALUATION_BASELINE_SCHEMA_VERSION) {
    throw new ValidationError(
      `Unsupported workflow evaluation baseline schema version ${String(value.schemaVersion)}.`
    );
  }
  const summary = validateSummary({
    total: value.total,
    passed: value.passed,
    failed: value.failed,
    passRate: value.passRate
  }, "baseline");
  const cases = validateReportCases(value.cases, "baseline.cases");
  if (cases.length !== summary.total) {
    throw new ValidationError("baseline.cases length must equal baseline.total.");
  }
  if (cases.filter((testCase) => testCase.ok).length !== summary.passed) {
    throw new ValidationError("baseline.passed must match the number of passing cases.");
  }
  const judgeScore = value.judgeScore === undefined
    ? undefined
    : assertRate(value.judgeScore, "baseline.judgeScore");
  let metadata: Record<string, JsonValue> | undefined;
  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata)) {
      throw new ValidationError("baseline.metadata must be an object.");
    }
    metadata = canonicalizeMetadata(value.metadata as Record<string, JsonValue>);
  }
  return {
    schemaVersion: WORKFLOW_EVALUATION_BASELINE_SCHEMA_VERSION,
    name: assertNonEmptyString(value.name, "baseline.name"),
    reportOk: assertBoolean(value.reportOk, "baseline.reportOk"),
    ...summary,
    judgeScore,
    cases,
    metadata
  };
};

const validateCountThreshold = (value: number, label: string): number =>
  assertInteger(value, label);

const resolveThresholds = (
  baseline: WorkflowEvaluationBaseline,
  thresholds: WorkflowEvaluationGateThresholds
): WorkflowEvaluationGateResolvedThresholds => {
  const resolved: WorkflowEvaluationGateResolvedThresholds = {
    minPassRate: assertRate(thresholds.minPassRate ?? 0, "thresholds.minPassRate"),
    maxPassRateDrop: assertRate(thresholds.maxPassRateDrop ?? 0, "thresholds.maxPassRateDrop"),
    maxFailedCases: validateCountThreshold(
      thresholds.maxFailedCases ?? baseline.failed,
      "thresholds.maxFailedCases"
    ),
    maxRegressedCases: validateCountThreshold(
      thresholds.maxRegressedCases ?? 0,
      "thresholds.maxRegressedCases"
    ),
    maxNewFailures: validateCountThreshold(
      thresholds.maxNewFailures ?? 0,
      "thresholds.maxNewFailures"
    ),
    maxRemovedCases: validateCountThreshold(
      thresholds.maxRemovedCases ?? 0,
      "thresholds.maxRemovedCases"
    ),
    requireCandidateOk: thresholds.requireCandidateOk ?? baseline.reportOk
  };
  if (thresholds.minJudgeScore !== undefined) {
    resolved.minJudgeScore = assertRate(thresholds.minJudgeScore, "thresholds.minJudgeScore");
  }
  if (thresholds.maxJudgeScoreDrop !== undefined || baseline.judgeScore !== undefined) {
    resolved.maxJudgeScoreDrop = assertRate(
      thresholds.maxJudgeScoreDrop ?? 0,
      "thresholds.maxJudgeScoreDrop"
    );
  }
  return resolved;
};

const setDifference = (left: string[], right: string[]): string[] => {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value)).sort();
};

const createCaseDiffs = (
  baselineCases: WorkflowEvaluationBaselineCase[],
  candidateCases: WorkflowEvaluationBaselineCase[]
): WorkflowEvaluationGateCaseDiff[] => {
  const baselineByName = new Map(baselineCases.map((testCase) => [testCase.name, testCase]));
  const candidateByName = new Map(candidateCases.map((testCase) => [testCase.name, testCase]));
  return [...new Set([...baselineByName.keys(), ...candidateByName.keys()])]
    .sort()
    .map((name): WorkflowEvaluationGateCaseDiff => {
      const baselineCase = baselineByName.get(name);
      const candidateCase = candidateByName.get(name);
      const newFailures = setDifference(candidateCase?.failures ?? [], baselineCase?.failures ?? []);
      const resolvedFailures = setDifference(baselineCase?.failures ?? [], candidateCase?.failures ?? []);
      let status: WorkflowEvaluationGateCaseDiff["status"];
      if (!baselineCase) {
        status = "added";
      } else if (!candidateCase) {
        status = "removed";
      } else if (
        baselineCase.ok !== candidateCase.ok ||
        baselineCase.status !== candidateCase.status ||
        newFailures.length > 0 ||
        resolvedFailures.length > 0
      ) {
        status = "changed";
      } else {
        status = "unchanged";
      }
      return {
        name,
        status,
        baselineOk: baselineCase?.ok,
        candidateOk: candidateCase?.ok,
        baselineStatus: baselineCase?.status,
        candidateStatus: candidateCase?.status,
        newFailures,
        resolvedFailures
      };
    });
};

const createCheck = (
  code: WorkflowEvaluationGateCheckCode,
  ok: boolean,
  actual: number | boolean | null,
  limit: number | boolean,
  message: string,
  baseline?: number | boolean
): WorkflowEvaluationGateCheck => ({ code, ok, actual, limit, baseline, message });

export const evaluateWorkflowEvaluationGate = (
  baselineValue: WorkflowEvaluationBaseline,
  candidateReport: WorkflowEvaluationReport,
  options: {
    thresholds?: WorkflowEvaluationGateThresholds;
    metadata?: Record<string, JsonValue>;
  } = {}
): WorkflowEvaluationGateResult => {
  const baseline = normalizeWorkflowEvaluationBaseline(baselineValue);
  const candidate = normalizeReport(candidateReport, "candidate");
  const thresholds = resolveThresholds(baseline, options.thresholds ?? {});
  const cases = createCaseDiffs(baseline.cases, candidate.cases);
  const regressedCases = cases.filter((testCase) =>
    (testCase.baselineOk === true && testCase.candidateOk === false) ||
    (testCase.status === "added" && testCase.candidateOk === false)
  ).length;
  const newFailures = cases.reduce((total, testCase) => total + testCase.newFailures.length, 0);
  const removedCases = cases.filter((testCase) => testCase.status === "removed").length;
  const passRateDrop = baseline.passRate - candidate.passRate;
  const checks: WorkflowEvaluationGateCheck[] = [];

  checks.push(createCheck(
    "candidate_ok",
    !thresholds.requireCandidateOk || candidate.ok,
    candidate.ok,
    thresholds.requireCandidateOk,
    thresholds.requireCandidateOk && !candidate.ok
      ? "Candidate report is failing but a passing verdict is required."
      : "Candidate report verdict satisfies the configured requirement.",
    baseline.reportOk
  ));
  checks.push(createCheck(
    "min_pass_rate",
    candidate.passRate >= thresholds.minPassRate,
    candidate.passRate,
    thresholds.minPassRate,
    candidate.passRate >= thresholds.minPassRate
      ? `Candidate pass rate ${candidate.passRate} meets the minimum ${thresholds.minPassRate}.`
      : `Candidate pass rate ${candidate.passRate} is below the minimum ${thresholds.minPassRate}.`,
    baseline.passRate
  ));
  checks.push(createCheck(
    "max_pass_rate_drop",
    passRateDrop <= thresholds.maxPassRateDrop,
    passRateDrop,
    thresholds.maxPassRateDrop,
    passRateDrop <= thresholds.maxPassRateDrop
      ? `Pass-rate drop ${passRateDrop} is within the maximum ${thresholds.maxPassRateDrop}.`
      : `Pass-rate drop ${passRateDrop} exceeds the maximum ${thresholds.maxPassRateDrop}.`,
    baseline.passRate
  ));
  checks.push(createCheck(
    "max_failed_cases",
    candidate.failed <= thresholds.maxFailedCases,
    candidate.failed,
    thresholds.maxFailedCases,
    candidate.failed <= thresholds.maxFailedCases
      ? `Candidate failed cases ${candidate.failed} are within the maximum ${thresholds.maxFailedCases}.`
      : `Candidate failed cases ${candidate.failed} exceed the maximum ${thresholds.maxFailedCases}.`,
    baseline.failed
  ));
  checks.push(createCheck(
    "max_regressed_cases",
    regressedCases <= thresholds.maxRegressedCases,
    regressedCases,
    thresholds.maxRegressedCases,
    regressedCases <= thresholds.maxRegressedCases
      ? `Regressed cases ${regressedCases} are within the maximum ${thresholds.maxRegressedCases}.`
      : `Regressed cases ${regressedCases} exceed the maximum ${thresholds.maxRegressedCases}.`
  ));
  checks.push(createCheck(
    "max_new_failures",
    newFailures <= thresholds.maxNewFailures,
    newFailures,
    thresholds.maxNewFailures,
    newFailures <= thresholds.maxNewFailures
      ? `New failures ${newFailures} are within the maximum ${thresholds.maxNewFailures}.`
      : `New failures ${newFailures} exceed the maximum ${thresholds.maxNewFailures}.`
  ));
  checks.push(createCheck(
    "max_removed_cases",
    removedCases <= thresholds.maxRemovedCases,
    removedCases,
    thresholds.maxRemovedCases,
    removedCases <= thresholds.maxRemovedCases
      ? `Removed cases ${removedCases} are within the maximum ${thresholds.maxRemovedCases}.`
      : `Removed cases ${removedCases} exceed the maximum ${thresholds.maxRemovedCases}.`
  ));

  if (thresholds.minJudgeScore !== undefined) {
    checks.push(createCheck(
      "min_judge_score",
      candidate.judgeScore !== undefined && candidate.judgeScore >= thresholds.minJudgeScore,
      candidate.judgeScore ?? null,
      thresholds.minJudgeScore,
      candidate.judgeScore === undefined
        ? "Candidate report does not include the required judge score."
        : candidate.judgeScore >= thresholds.minJudgeScore
          ? `Candidate judge score ${candidate.judgeScore} meets the minimum ${thresholds.minJudgeScore}.`
          : `Candidate judge score ${candidate.judgeScore} is below the minimum ${thresholds.minJudgeScore}.`,
      baseline.judgeScore
    ));
  }

  if (thresholds.maxJudgeScoreDrop !== undefined) {
    const judgeDrop = baseline.judgeScore !== undefined && candidate.judgeScore !== undefined
      ? baseline.judgeScore - candidate.judgeScore
      : undefined;
    checks.push(createCheck(
      "max_judge_score_drop",
      judgeDrop !== undefined && judgeDrop <= thresholds.maxJudgeScoreDrop,
      judgeDrop ?? null,
      thresholds.maxJudgeScoreDrop,
      baseline.judgeScore === undefined
        ? "Baseline does not include the judge score required for a relative judge-score gate."
        : candidate.judgeScore === undefined
          ? "Candidate report does not include the judge score required for a relative judge-score gate."
          : judgeDrop! <= thresholds.maxJudgeScoreDrop
            ? `Judge-score drop ${judgeDrop} is within the maximum ${thresholds.maxJudgeScoreDrop}.`
            : `Judge-score drop ${judgeDrop} exceeds the maximum ${thresholds.maxJudgeScoreDrop}.`,
      baseline.judgeScore
    ));
  }

  const issues = checks.filter((check) => !check.ok);
  return {
    schemaVersion: WORKFLOW_EVALUATION_GATE_SCHEMA_VERSION,
    ok: issues.length === 0,
    baseline: {
      schemaVersion: baseline.schemaVersion,
      name: baseline.name,
      reportOk: baseline.reportOk,
      total: baseline.total,
      passed: baseline.passed,
      failed: baseline.failed,
      passRate: baseline.passRate,
      judgeScore: baseline.judgeScore
    },
    candidate: {
      ok: candidate.ok,
      total: candidate.total,
      passed: candidate.passed,
      failed: candidate.failed,
      passRate: candidate.passRate,
      judgeScore: candidate.judgeScore
    },
    delta: {
      total: candidate.total - baseline.total,
      passed: candidate.passed - baseline.passed,
      failed: candidate.failed - baseline.failed,
      passRate: candidate.passRate - baseline.passRate,
      judgeScore: baseline.judgeScore !== undefined && candidate.judgeScore !== undefined
        ? candidate.judgeScore - baseline.judgeScore
        : undefined
    },
    summary: {
      addedCases: cases.filter((testCase) => testCase.status === "added").length,
      removedCases,
      changedCases: cases.filter((testCase) => testCase.status === "changed").length,
      unchangedCases: cases.filter((testCase) => testCase.status === "unchanged").length,
      regressedCases,
      newFailures,
      resolvedFailures: cases.reduce((total, testCase) => total + testCase.resolvedFailures.length, 0)
    },
    thresholds,
    checks,
    issues,
    cases,
    metadata: canonicalizeMetadata(options.metadata)
  };
};
