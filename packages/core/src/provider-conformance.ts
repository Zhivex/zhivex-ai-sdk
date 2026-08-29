import { ValidationError } from "./errors.js";
import { createRedactionPolicy, type RedactionPolicyOptions } from "./safety-policy.js";
import type { JsonValue } from "./types.js";

export const PROVIDER_CONFORMANCE_REPORT_SCHEMA_VERSION = 1 as const;

export const PROVIDER_CONFORMANCE_STATUSES = [
  "implemented",
  "offline_passed",
  "installed_passed",
  "live_passed",
  "skipped_missing_credentials",
  "failed",
  "stale"
] as const;

export const PROVIDER_CONFORMANCE_EVIDENCE_LEVELS = [
  "declared",
  "offline",
  "installed",
  "live"
] as const;

export type ProviderConformanceStatus = (typeof PROVIDER_CONFORMANCE_STATUSES)[number];
export type ProviderConformanceEvidenceLevel = (typeof PROVIDER_CONFORMANCE_EVIDENCE_LEVELS)[number];
export type ProviderConformanceArtifactKind = "checkout" | "installed";
export type ProviderConformancePassingStatus =
  | "implemented"
  | "offline_passed"
  | "installed_passed"
  | "live_passed";

export interface ProviderConformanceArtifact {
  kind: ProviderConformanceArtifactKind;
  packageName: string;
  packageVersion: string;
  integrity?: string;
}

export interface ProviderConformanceError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ProviderConformanceCapabilityResult {
  capability: string;
  evidence: ProviderConformanceEvidenceLevel;
  status: ProviderConformanceStatus;
  observedStatus?: Exclude<ProviderConformanceStatus, "stale">;
  required: boolean;
  modelId: string;
  endpoint: string;
  artifact: ProviderConformanceArtifact;
  observedAt: string;
  expiresAt: string;
  attempts: number;
  durationMs?: number;
  error?: ProviderConformanceError;
  missingRequirements?: string[];
  metadata?: Record<string, JsonValue>;
}

export interface ProviderConformanceProviderReport {
  provider: string;
  results: ProviderConformanceCapabilityResult[];
}

export interface ProviderConformanceCiContext {
  system: string;
  runId: string;
  runAttempt?: string;
  workflow?: string;
}

export interface ProviderConformanceReport {
  schemaVersion: typeof PROVIDER_CONFORMANCE_REPORT_SCHEMA_VERSION;
  reportId: string;
  generatedAt: string;
  expiresAt: string;
  generator: string;
  source: {
    repository: string;
    gitSha: string;
    runtime: string;
    ci?: ProviderConformanceCiContext;
  };
  providers: ProviderConformanceProviderReport[];
}

export interface NormalizeProviderConformanceOptions {
  now?: Date | string;
  applyTtl?: boolean;
  redaction?: RedactionPolicyOptions;
}

export interface ProviderConformanceRegression {
  provider: string;
  capability: string;
  evidence: ProviderConformanceEvidenceLevel;
  artifactKind: ProviderConformanceArtifactKind;
  baselineStatus: ProviderConformanceStatus;
  currentStatus: ProviderConformanceStatus | "missing";
  baselineModelId: string;
  currentModelId?: string;
}

export interface ProviderConformanceChange {
  provider: string;
  capability: string;
  evidence: ProviderConformanceEvidenceLevel;
  artifactKind: ProviderConformanceArtifactKind;
  field: "modelId" | "endpoint" | "packageVersion";
  baseline: string;
  current: string;
}

export interface ProviderConformanceComparison {
  ok: boolean;
  regressions: ProviderConformanceRegression[];
  changes: ProviderConformanceChange[];
}

export interface ProviderConformanceRequirement {
  provider: string;
  capability: string;
  evidence: ProviderConformanceEvidenceLevel;
  artifactKind?: ProviderConformanceArtifactKind;
}

export interface ProviderConformanceGateIssue {
  code: "missing_required_result" | "required_result_not_passed" | "baseline_regression";
  provider: string;
  capability: string;
  evidence: ProviderConformanceEvidenceLevel;
  status?: ProviderConformanceStatus;
  message: string;
}

export interface ProviderConformanceGateResult {
  ok: boolean;
  issues: ProviderConformanceGateIssue[];
  comparison?: ProviderConformanceComparison;
}

export interface EvaluateProviderConformanceGateOptions {
  baseline?: ProviderConformanceReport | unknown;
  requirements?: ProviderConformanceRequirement[];
  now?: Date | string;
}

const statusSet = new Set<string>(PROVIDER_CONFORMANCE_STATUSES);
const evidenceSet = new Set<string>(PROVIDER_CONFORMANCE_EVIDENCE_LEVELS);
const passingStatusByEvidence: Record<ProviderConformanceEvidenceLevel, ProviderConformancePassingStatus> = {
  declared: "implemented",
  offline: "offline_passed",
  installed: "installed_passed",
  live: "live_passed"
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const requireRecord = (value: unknown, path: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new ValidationError(`${path} must be an object.`);
  }
  return value;
};

const requireString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${path} must be a non-empty string.`);
  }
  return value.trim();
};

const optionalString = (value: unknown, path: string): string | undefined =>
  value === undefined ? undefined : requireString(value, path);

const requireLogicalEndpoint = (value: unknown, path: string): string => {
  const endpoint = requireString(value, path);
  if (endpoint.includes("://") || endpoint.includes("@") || endpoint.includes("?") || endpoint.includes("#")) {
    throw new ValidationError(`${path} must be a logical endpoint label, not a URL or tenant-bearing identifier.`);
  }
  return endpoint;
};

const requireBoolean = (value: unknown, path: string): boolean => {
  if (typeof value !== "boolean") {
    throw new ValidationError(`${path} must be a boolean.`);
  }
  return value;
};

const requireNonNegativeInteger = (value: unknown, path: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ValidationError(`${path} must be a non-negative safe integer.`);
  }
  return value as number;
};

const optionalNonNegativeNumber = (value: unknown, path: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ValidationError(`${path} must be a non-negative finite number.`);
  }
  return value;
};

const requireIsoDate = (value: unknown, path: string): string => {
  const input = requireString(value, path);
  const timestamp = Date.parse(input);
  if (!Number.isFinite(timestamp)) {
    throw new ValidationError(`${path} must be an ISO-8601 timestamp.`);
  }
  return new Date(timestamp).toISOString();
};

const resolveNow = (value: Date | string | undefined): number => {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new ValidationError("now must be a valid date.");
    return value.getTime();
  }
  if (value !== undefined) {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) throw new ValidationError("now must be a valid date.");
    return timestamp;
  }
  return Date.now();
};

const normalizeStringArray = (value: unknown, path: string, redact: (value: string) => string): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ValidationError(`${path} must be an array.`);
  return value.map((entry, index) => redact(requireString(entry, `${path}[${index}]`)));
};

const normalizeMetadata = (
  value: unknown,
  path: string,
  redactJson: <T extends JsonValue | undefined>(input: T) => T
): Record<string, JsonValue> | undefined => {
  if (value === undefined) return undefined;
  const record = requireRecord(value, path);
  const seen = new WeakSet<object>();
  const isJsonValue = (input: unknown): input is JsonValue => {
    if (input === null || typeof input === "string" || typeof input === "boolean") return true;
    if (typeof input === "number") return Number.isFinite(input);
    if (!input || typeof input !== "object") return false;
    if (seen.has(input)) return false;
    seen.add(input);
    const valid = Array.isArray(input)
      ? input.every(isJsonValue)
      : Object.getPrototypeOf(input) === Object.prototype && Object.values(input).every(isJsonValue);
    seen.delete(input);
    return valid;
  };
  if (!isJsonValue(record)) {
    throw new ValidationError(`${path} must contain only JSON-compatible values.`);
  }
  return redactJson(structuredClone(record) as JsonValue) as Record<string, JsonValue>;
};

const normalizeArtifact = (value: unknown, path: string): ProviderConformanceArtifact => {
  const record = requireRecord(value, path);
  const kind = requireString(record.kind, `${path}.kind`);
  if (kind !== "checkout" && kind !== "installed") {
    throw new ValidationError(`${path}.kind must be checkout or installed.`);
  }
  return {
    kind,
    packageName: requireString(record.packageName, `${path}.packageName`),
    packageVersion: requireString(record.packageVersion, `${path}.packageVersion`),
    integrity: optionalString(record.integrity, `${path}.integrity`)
  };
};

const normalizeStatus = (value: unknown, path: string): ProviderConformanceStatus => {
  const status = requireString(value, path);
  if (!statusSet.has(status)) {
    throw new ValidationError(`${path} contains an unknown provider conformance status.`);
  }
  return status as ProviderConformanceStatus;
};

const normalizeEvidence = (value: unknown, path: string): ProviderConformanceEvidenceLevel => {
  const evidence = requireString(value, path);
  if (!evidenceSet.has(evidence)) {
    throw new ValidationError(`${path} contains an unknown provider conformance evidence level.`);
  }
  return evidence as ProviderConformanceEvidenceLevel;
};

const normalizeError = (
  value: unknown,
  path: string,
  redact: (value: string) => string
): ProviderConformanceError | undefined => {
  if (value === undefined) return undefined;
  const record = requireRecord(value, path);
  return {
    code: redact(requireString(record.code, `${path}.code`)),
    message: redact(requireString(record.message, `${path}.message`)),
    retryable: requireBoolean(record.retryable, `${path}.retryable`)
  };
};

const normalizeResult = (
  value: unknown,
  path: string,
  now: number,
  applyTtl: boolean,
  redaction: ReturnType<typeof createRedactionPolicy>
): ProviderConformanceCapabilityResult => {
  const record = requireRecord(value, path);
  const evidence = normalizeEvidence(record.evidence, `${path}.evidence`);
  let status = normalizeStatus(record.status, `${path}.status`);
  let observedStatus: Exclude<ProviderConformanceStatus, "stale"> | undefined;
  if (record.observedStatus !== undefined) {
    const parsedObservedStatus = normalizeStatus(record.observedStatus, `${path}.observedStatus`);
    if (parsedObservedStatus === "stale") {
      throw new ValidationError(`${path}.observedStatus cannot itself be stale.`);
    }
    observedStatus = parsedObservedStatus;
  }
  const observedAt = requireIsoDate(record.observedAt, `${path}.observedAt`);
  const expiresAt = requireIsoDate(record.expiresAt, `${path}.expiresAt`);
  if (Date.parse(expiresAt) < Date.parse(observedAt)) {
    throw new ValidationError(`${path}.expiresAt cannot precede observedAt.`);
  }
  if (status === "stale" && !observedStatus) {
    throw new ValidationError(`${path}.observedStatus is required when status is stale.`);
  }
  if (status !== "stale" && observedStatus !== undefined) {
    throw new ValidationError(`${path}.observedStatus is only allowed when status is stale.`);
  }
  if (
    applyTtl &&
    status !== "failed" &&
    status !== "skipped_missing_credentials" &&
    status !== "stale" &&
    Date.parse(expiresAt) <= now
  ) {
    observedStatus = status;
    status = "stale";
  }
  if (status !== "failed" && record.error !== undefined) {
    throw new ValidationError(`${path}.error is only allowed for failed results.`);
  }
  const error = normalizeError(record.error, `${path}.error`, redaction.redactText);
  if (status === "failed" && !error) {
    throw new ValidationError(`${path}.error is required for failed results.`);
  }
  const expectedPassingStatus = passingStatusByEvidence[evidence];
  const effectiveStatus = status === "stale" ? observedStatus : status;
  if (
    effectiveStatus !== undefined &&
    status !== "failed" &&
    status !== "skipped_missing_credentials" &&
    effectiveStatus !== expectedPassingStatus
  ) {
    throw new ValidationError(`${path}.status is incompatible with its evidence level.`);
  }

  return {
    capability: requireString(record.capability, `${path}.capability`),
    evidence,
    status,
    observedStatus,
    required: requireBoolean(record.required, `${path}.required`),
    modelId: requireString(record.modelId, `${path}.modelId`),
    endpoint: requireLogicalEndpoint(record.endpoint, `${path}.endpoint`),
    artifact: normalizeArtifact(record.artifact, `${path}.artifact`),
    observedAt,
    expiresAt,
    attempts: requireNonNegativeInteger(record.attempts, `${path}.attempts`),
    durationMs: optionalNonNegativeNumber(record.durationMs, `${path}.durationMs`),
    error,
    missingRequirements: normalizeStringArray(
      record.missingRequirements,
      `${path}.missingRequirements`,
      redaction.redactText
    ),
    metadata: normalizeMetadata(record.metadata, `${path}.metadata`, redaction.redactJson)
  };
};

const resultKey = (provider: string, result: ProviderConformanceCapabilityResult): string =>
  [provider, result.capability, result.evidence, result.artifact.kind].join("\u0000");

export const normalizeProviderConformanceReport = (
  value: unknown,
  options: NormalizeProviderConformanceOptions = {}
): ProviderConformanceReport => {
  const record = requireRecord(value, "report");
  if (record.schemaVersion !== PROVIDER_CONFORMANCE_REPORT_SCHEMA_VERSION) {
    throw new ValidationError(
      `Unsupported provider conformance report schema version ${String(record.schemaVersion)}.`
    );
  }
  const redaction = createRedactionPolicy({
    includeEmails: true,
    ...options.redaction,
    rules: [
      {
        name: "provider-conformance-token",
        pattern: /\b(?:sk|pk|rk|api|token)[-_][A-Za-z0-9._-]{16,}\b/gi
      },
      ...(options.redaction?.rules ?? [])
    ]
  });
  const now = resolveNow(options.now);
  const applyTtl = options.applyTtl ?? true;
  const source = requireRecord(record.source, "report.source");
  const ciInput = source.ci;
  let ci: ProviderConformanceCiContext | undefined;
  if (ciInput !== undefined) {
    const ciRecord = requireRecord(ciInput, "report.source.ci");
    ci = {
      system: requireString(ciRecord.system, "report.source.ci.system"),
      runId: requireString(ciRecord.runId, "report.source.ci.runId"),
      runAttempt: optionalString(ciRecord.runAttempt, "report.source.ci.runAttempt"),
      workflow: optionalString(ciRecord.workflow, "report.source.ci.workflow")
    };
  }
  if (!Array.isArray(record.providers)) {
    throw new ValidationError("report.providers must be an array.");
  }
  const seenProviders = new Set<string>();
  const seenResults = new Set<string>();
  const providers = record.providers.map((providerValue, providerIndex): ProviderConformanceProviderReport => {
    const providerRecord = requireRecord(providerValue, `report.providers[${providerIndex}]`);
    const provider = requireString(providerRecord.provider, `report.providers[${providerIndex}].provider`);
    if (seenProviders.has(provider)) {
      throw new ValidationError(`report.providers contains duplicate provider ${provider}.`);
    }
    seenProviders.add(provider);
    if (!Array.isArray(providerRecord.results)) {
      throw new ValidationError(`report.providers[${providerIndex}].results must be an array.`);
    }
    const results = providerRecord.results.map((result, resultIndex) =>
      normalizeResult(
        result,
        `report.providers[${providerIndex}].results[${resultIndex}]`,
        now,
        applyTtl,
        redaction
      )
    );
    for (const result of results) {
      const key = resultKey(provider, result);
      if (seenResults.has(key)) {
        throw new ValidationError(
          `report.providers contains duplicate evidence for ${provider}/${result.capability}/${result.evidence}/${result.artifact.kind}.`
        );
      }
      seenResults.add(key);
    }
    return {
      provider,
      results: results.sort((left, right) =>
        left.capability.localeCompare(right.capability) ||
        left.evidence.localeCompare(right.evidence) ||
        left.artifact.kind.localeCompare(right.artifact.kind)
      )
    };
  });
  const generatedAt = requireIsoDate(record.generatedAt, "report.generatedAt");
  const expiresAt = requireIsoDate(record.expiresAt, "report.expiresAt");
  if (Date.parse(expiresAt) < Date.parse(generatedAt)) {
    throw new ValidationError("report.expiresAt cannot precede generatedAt.");
  }

  return {
    schemaVersion: PROVIDER_CONFORMANCE_REPORT_SCHEMA_VERSION,
    reportId: requireString(record.reportId, "report.reportId"),
    generatedAt,
    expiresAt,
    generator: requireString(record.generator, "report.generator"),
    source: {
      repository: requireString(source.repository, "report.source.repository"),
      gitSha: requireString(source.gitSha, "report.source.gitSha"),
      runtime: requireString(source.runtime, "report.source.runtime"),
      ci
    },
    providers: providers.sort((left, right) => left.provider.localeCompare(right.provider))
  };
};

export const mergeProviderConformanceReports = (
  reports: Array<ProviderConformanceReport | unknown>,
  options: NormalizeProviderConformanceOptions = {}
): ProviderConformanceReport => {
  if (reports.length === 0) throw new ValidationError("At least one provider conformance report is required.");
  const normalized = reports.map((report) => normalizeProviderConformanceReport(report, options));
  const first = normalized[0]!;
  for (const report of normalized.slice(1)) {
    if (
      first.source.repository !== report.source.repository ||
      first.source.gitSha !== report.source.gitSha
    ) {
      throw new ValidationError("Provider conformance reports must describe the same repository and git SHA.");
    }
  }
  const providerResults = new Map<string, Map<string, ProviderConformanceCapabilityResult>>();
  for (const report of normalized) {
    for (const provider of report.providers) {
      const results = providerResults.get(provider.provider) ?? new Map<string, ProviderConformanceCapabilityResult>();
      for (const result of provider.results) {
        results.set(resultKey(provider.provider, result), result);
      }
      providerResults.set(provider.provider, results);
    }
  }
  const generatedAt = normalized
    .map((report) => report.generatedAt)
    .sort()
    .at(-1)!;
  const expiresAt = normalized
    .map((report) => report.expiresAt)
    .sort()
    .at(-1)!;
  return normalizeProviderConformanceReport({
    ...first,
    reportId: `${first.reportId}-merged`,
    generatedAt,
    expiresAt,
    providers: [...providerResults.entries()].map(([provider, results]) => ({
      provider,
      results: [...results.values()]
    }))
  }, options);
};

export const compareProviderConformanceReports = (
  baselineInput: ProviderConformanceReport | unknown,
  currentInput: ProviderConformanceReport | unknown,
  options: Pick<NormalizeProviderConformanceOptions, "now"> = {}
): ProviderConformanceComparison => {
  const baseline = normalizeProviderConformanceReport(baselineInput, { ...options, applyTtl: false });
  const current = normalizeProviderConformanceReport(currentInput, { ...options, applyTtl: true });
  const currentResults = new Map<string, ProviderConformanceCapabilityResult>();
  for (const provider of current.providers) {
    for (const result of provider.results) currentResults.set(resultKey(provider.provider, result), result);
  }
  const regressions: ProviderConformanceRegression[] = [];
  const changes: ProviderConformanceChange[] = [];
  for (const provider of baseline.providers) {
    for (const baselineResult of provider.results) {
      const currentResult = currentResults.get(resultKey(provider.provider, baselineResult));
      const expectedStatus = passingStatusByEvidence[baselineResult.evidence];
      if (!currentResult || currentResult.status !== expectedStatus) {
        regressions.push({
          provider: provider.provider,
          capability: baselineResult.capability,
          evidence: baselineResult.evidence,
          artifactKind: baselineResult.artifact.kind,
          baselineStatus: baselineResult.status,
          currentStatus: currentResult?.status ?? "missing",
          baselineModelId: baselineResult.modelId,
          currentModelId: currentResult?.modelId
        });
        continue;
      }
      const fields = ["modelId", "endpoint"] as const;
      for (const field of fields) {
        if (baselineResult[field] !== currentResult[field]) {
          changes.push({
            provider: provider.provider,
            capability: baselineResult.capability,
            evidence: baselineResult.evidence,
            artifactKind: baselineResult.artifact.kind,
            field,
            baseline: baselineResult[field],
            current: currentResult[field]
          });
        }
      }
      if (baselineResult.artifact.packageVersion !== currentResult.artifact.packageVersion) {
        changes.push({
          provider: provider.provider,
          capability: baselineResult.capability,
          evidence: baselineResult.evidence,
          artifactKind: baselineResult.artifact.kind,
          field: "packageVersion",
          baseline: baselineResult.artifact.packageVersion,
          current: currentResult.artifact.packageVersion
        });
      }
    }
  }
  return { ok: regressions.length === 0, regressions, changes };
};

export const evaluateProviderConformanceGate = (
  reportInput: ProviderConformanceReport | unknown,
  options: EvaluateProviderConformanceGateOptions = {}
): ProviderConformanceGateResult => {
  const report = normalizeProviderConformanceReport(reportInput, { now: options.now });
  const requirements: ProviderConformanceRequirement[] = [...(options.requirements ?? [])];
  for (const provider of report.providers) {
    for (const result of provider.results) {
      if (result.required) {
        requirements.push({
          provider: provider.provider,
          capability: result.capability,
          evidence: result.evidence,
          artifactKind: result.artifact.kind
        });
      }
    }
  }
  const uniqueRequirements = new Map(
    requirements.map((requirement) => [
      [requirement.provider, requirement.capability, requirement.evidence, requirement.artifactKind ?? "*"].join("\u0000"),
      requirement
    ])
  );
  const issues: ProviderConformanceGateIssue[] = [];
  for (const requirement of uniqueRequirements.values()) {
    const provider = report.providers.find((entry) => entry.provider === requirement.provider);
    const result = provider?.results.find((entry) =>
      entry.capability === requirement.capability &&
      entry.evidence === requirement.evidence &&
      (!requirement.artifactKind || entry.artifact.kind === requirement.artifactKind)
    );
    if (!result) {
      issues.push({
        code: "missing_required_result",
        provider: requirement.provider,
        capability: requirement.capability,
        evidence: requirement.evidence,
        message: `Missing required ${requirement.evidence} evidence for ${requirement.provider}/${requirement.capability}.`
      });
      continue;
    }
    if (result.status !== passingStatusByEvidence[requirement.evidence]) {
      issues.push({
        code: "required_result_not_passed",
        provider: requirement.provider,
        capability: requirement.capability,
        evidence: requirement.evidence,
        status: result.status,
        message: `Required ${requirement.evidence} evidence for ${requirement.provider}/${requirement.capability} is ${result.status}.`
      });
    }
  }
  const comparison = options.baseline
    ? compareProviderConformanceReports(options.baseline, report, { now: options.now })
    : undefined;
  for (const regression of comparison?.regressions ?? []) {
    issues.push({
      code: "baseline_regression",
      provider: regression.provider,
      capability: regression.capability,
      evidence: regression.evidence,
      status: regression.currentStatus === "missing" ? undefined : regression.currentStatus,
      message: `Baseline regression for ${regression.provider}/${regression.capability}/${regression.evidence}: ${regression.currentStatus}.`
    });
  }
  return { ok: issues.length === 0, issues, comparison };
};

const escapeMarkdown = (value: string): string => value.replaceAll("|", "\\|").replaceAll("\n", " ");

export const renderProviderConformanceMarkdown = (
  reportInput: ProviderConformanceReport | unknown,
  options: Pick<NormalizeProviderConformanceOptions, "now"> = {}
): string => {
  const report = normalizeProviderConformanceReport(reportInput, { now: options.now });
  const results = report.providers.flatMap((provider) =>
    provider.results.map((result) => ({ provider: provider.provider, ...result }))
  );
  const statusCounts = new Map<ProviderConformanceStatus, number>();
  for (const result of results) statusCounts.set(result.status, (statusCounts.get(result.status) ?? 0) + 1);
  const lines = [
    "# Zhivex AI SDK Provider Conformance Report",
    "",
    `- Schema: ${report.schemaVersion}`,
    `- Report: ${escapeMarkdown(report.reportId)}`,
    `- Generated: ${report.generatedAt}`,
    `- Expires: ${report.expiresAt}`,
    `- Git SHA: ${escapeMarkdown(report.source.gitSha)}`,
    `- Results: ${results.length}`,
    `- Live passed: ${statusCounts.get("live_passed") ?? 0}`,
    `- Installed passed: ${statusCounts.get("installed_passed") ?? 0}`,
    `- Skipped credentials: ${statusCounts.get("skipped_missing_credentials") ?? 0}`,
    `- Failed: ${statusCounts.get("failed") ?? 0}`,
    `- Stale: ${statusCounts.get("stale") ?? 0}`,
    "",
    "| Provider | Capability | Evidence | Status | Model | Endpoint | Artifact | Package | Observed | Expires | Required |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  ];
  for (const result of results) {
    lines.push(`| ${[
      result.provider,
      result.capability,
      result.evidence,
      result.status,
      result.modelId,
      result.endpoint,
      result.artifact.kind,
      `${result.artifact.packageName}@${result.artifact.packageVersion}`,
      result.observedAt,
      result.expiresAt,
      result.required ? "yes" : "no"
    ].map((value) => escapeMarkdown(String(value))).join(" | ")} |`);
  }
  lines.push("", "Skipped results are not certifications. Stale or failed required evidence fails closed.", "");
  return lines.join("\n");
};
