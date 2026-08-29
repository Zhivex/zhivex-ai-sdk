import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createRedactionPolicy,
  evaluateProviderConformanceGate,
  mergeProviderConformanceReports,
  normalizeProviderConformanceReport,
  PROVIDER_CONFORMANCE_REPORT_SCHEMA_VERSION,
  renderProviderConformanceMarkdown,
  type ProviderConformanceCapabilityResult,
  type ProviderConformanceEvidenceLevel,
  type ProviderConformanceReport,
  type ProviderConformanceRequirement
} from "../packages/core/src/index.js";
import {
  integrationProviderStatuses,
  type IntegrationProviderStatus
} from "../packages/core/tests/integration-registry.js";

interface CliOptions {
  jsonPath?: string;
  markdownPath?: string;
  baselinePath?: string;
  mergePaths: string[];
  offlinePassed: boolean;
  runLive: boolean;
  gate: "off" | "warn" | "required";
  ttlHours: number;
  requirements: ProviderConformanceRequirement[];
}

interface VitestAssertion {
  ancestorTitles?: string[];
  status?: string;
  title?: string;
  duration?: number;
  failureMessages?: string[];
}

interface VitestJsonReport {
  success?: boolean;
  testResults?: Array<{ assertionResults?: VitestAssertion[] }>;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = resolve(scriptDirectory, "..");
const diagnosticRedaction = createRedactionPolicy({
  includeEmails: true,
  rules: [{ pattern: /\b(?:sk|pk|rk|api|token)[-_][A-Za-z0-9._-]{16,}\b/gi }]
});

const readArgValue = (argument: string, name: string): string | undefined =>
  argument.startsWith(`${name}=`) ? argument.slice(name.length + 1) : undefined;

const parseRequirement = (value: string): ProviderConformanceRequirement => {
  const [provider, capability, evidence = "live", artifactKind] = value.split(":");
  if (!provider || !capability || !["declared", "offline", "installed", "live"].includes(evidence)) {
    throw new Error(
      `Invalid --required value ${value}. Use provider:capability[:declared|offline|installed|live][:checkout|installed].`
    );
  }
  if (artifactKind && artifactKind !== "checkout" && artifactKind !== "installed") {
    throw new Error(`Invalid artifact kind in --required value ${value}.`);
  }
  return {
    provider,
    capability,
    evidence: evidence as ProviderConformanceEvidenceLevel,
    artifactKind: artifactKind as "checkout" | "installed" | undefined
  };
};

export const parseProviderConformanceCliOptions = (args: string[]): CliOptions => {
  const options: CliOptions = {
    mergePaths: [],
    offlinePassed: false,
    runLive: false,
    gate: "off",
    ttlHours: 168,
    requirements: []
  };
  for (const argument of args) {
    if (argument === "--offline-passed") options.offlinePassed = true;
    else if (argument === "--run-live") options.runLive = true;
    else if (readArgValue(argument, "--json") !== undefined) options.jsonPath = readArgValue(argument, "--json");
    else if (readArgValue(argument, "--markdown") !== undefined) options.markdownPath = readArgValue(argument, "--markdown");
    else if (readArgValue(argument, "--baseline") !== undefined) options.baselinePath = readArgValue(argument, "--baseline");
    else if (readArgValue(argument, "--merge") !== undefined) {
      options.mergePaths.push(...readArgValue(argument, "--merge")!.split(",").filter(Boolean));
    } else if (readArgValue(argument, "--required") !== undefined) {
      options.requirements.push(parseRequirement(readArgValue(argument, "--required")!));
    } else if (readArgValue(argument, "--gate") !== undefined) {
      const gate = readArgValue(argument, "--gate");
      if (gate !== "off" && gate !== "warn" && gate !== "required") {
        throw new Error("--gate must be off, warn, or required.");
      }
      options.gate = gate;
    } else if (readArgValue(argument, "--ttl-hours") !== undefined) {
      const ttlHours = Number(readArgValue(argument, "--ttl-hours"));
      if (!Number.isFinite(ttlHours) || ttlHours <= 0) throw new Error("--ttl-hours must be positive.");
      options.ttlHours = ttlHours;
    } else if (argument === "--help") {
      console.log([
        "Usage: bun run scripts/provider-smoke-report.ts [options]",
        "  --offline-passed              Record the already-completed offline suite.",
        "  --run-live                    Run common live provider tests and record per-capability results.",
        "  --merge=one.json,two.json     Merge evidence for the same repository and git SHA.",
        "  --baseline=report.json        Compare against a versioned baseline.",
        "  --required=p:c[:level][:kind] Require specific evidence (repeatable).",
        "  --gate=off|warn|required      Control fail-closed behavior.",
        "  --json=report.json            Write machine-readable output.",
        "  --markdown=report.md          Write the human-readable summary.",
        "  --ttl-hours=168               Set evidence TTL."
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument ${argument}.`);
    }
  }
  return options;
};

const packageVersion = (packageName: string): string => {
  const directory = packageName.replace("@zhivex-ai/", "");
  const manifest = JSON.parse(readFileSync(join(workspaceDirectory, "packages", directory, "package.json"), "utf8")) as {
    version?: string;
  };
  if (!manifest.version) throw new Error(`${packageName} is missing a package version.`);
  return manifest.version;
};

const gitSha = (): string => {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspaceDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "unknown";
  }
};

const capabilityNames = (provider: IntegrationProviderStatus): string[] => {
  const capabilities = ["generateText"];
  if (provider.supports.streaming) capabilities.push("streamText");
  if (provider.supports.tools) capabilities.push("tools", "agent_tool_loop");
  if (provider.supports.structuredOutputMode) capabilities.push("structuredOutput");
  if (provider.supports.embeddings) capabilities.push("embeddings");
  if (provider.supports.reasoning) capabilities.push("reasoning");
  return capabilities;
};

const modelIdForCapability = (provider: IntegrationProviderStatus, capability: string): string =>
  capability === "embeddings" ? provider.embeddingModelId ?? provider.textModelId : provider.textModelId;

const createResult = (input: {
  provider: IntegrationProviderStatus;
  capability: string;
  evidence: ProviderConformanceEvidenceLevel;
  status: ProviderConformanceCapabilityResult["status"];
  observedAt: string;
  expiresAt: string;
  required?: boolean;
  attempts?: number;
  durationMs?: number;
  error?: ProviderConformanceCapabilityResult["error"];
  missingRequirements?: string[];
}): ProviderConformanceCapabilityResult => ({
  capability: input.capability,
  evidence: input.evidence,
  status: input.status,
  required: input.required ?? false,
  modelId: modelIdForCapability(input.provider, input.capability),
  endpoint: input.provider.endpoint,
  artifact: {
    kind: "checkout",
    packageName: input.provider.packageName,
    packageVersion: packageVersion(input.provider.packageName)
  },
  observedAt: input.observedAt,
  expiresAt: input.expiresAt,
  attempts: input.attempts ?? 0,
  durationMs: input.durationMs,
  error: input.error,
  missingRequirements: input.missingRequirements
});

const assertionCapability = (assertion: VitestAssertion): string | undefined => {
  const suite = assertion.ancestorTitles?.join(" ") ?? "";
  if (suite.includes("generateText capability integration")) return "generateText";
  if (suite.includes("streamText capability integration")) return "streamText";
  if (suite.includes("tool calling capability integration")) return "tools";
  if (suite.includes("structured output capability integration")) return "structuredOutput";
  if (suite.includes("embeddings capability integration")) return "embeddings";
  if (suite.includes("reasoning capability integration")) return "reasoning";
  if (suite.includes("live agent providers with real Postgres durability")) return "agent_tool_loop";
  return undefined;
};

const assertionProvider = (assertion: VitestAssertion): IntegrationProviderStatus | undefined =>
  integrationProviderStatuses.find((provider) => assertion.title?.startsWith(`${provider.name} `));

const retryableFailure = (message: string): boolean =>
  /(?:408|409|425|429|5\d\d|timed?\s*out|timeout|fetch failed|ECONN|EAI_AGAIN|temporar|rate.?limit)/i.test(message);

const sanitizeFailureSummary = (message: string): string => {
  const firstLine = message.split("\n", 1)[0]?.trim() || "Live provider capability failed.";
  return diagnosticRedaction.redactText(firstLine.slice(0, 500));
};

const runLiveTests = (): { report: VitestJsonReport; processStatus: number } => {
  const directory = mkdtempSync(join(tmpdir(), "zhivex-provider-conformance-"));
  const outputPath = join(directory, "vitest.json");
  const files = [
    "packages/core/tests/text-streaming.integration.test.ts",
    "packages/core/tests/tools-structured-output.integration.test.ts",
    "packages/core/tests/embeddings.integration.test.ts",
    "packages/core/tests/reasoning.integration.test.ts"
  ];
  if (process.env.ZHIVEX_AGENT_LIVE_CERTIFICATION === "1") {
    files.push("packages/core/tests/agent-live.integration.test.ts");
  }
  try {
    const outcome = spawnSync(
      "bunx",
      [
        "vitest",
        "run",
        "--config",
        "vitest.integration.config.ts",
        ...files,
        "--reporter=json",
        `--outputFile=${outputPath}`
      ],
      {
        cwd: workspaceDirectory,
        env: process.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    if (!outcome.stdout.includes("JSON report written")) {
      const diagnostic = sanitizeFailureSummary(outcome.stderr || outcome.stdout || "Vitest did not produce a report.");
      throw new Error(diagnostic);
    }
    return {
      report: JSON.parse(readFileSync(outputPath, "utf8")) as VitestJsonReport,
      processStatus: outcome.status ?? 1
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const liveResults = (
  report: VitestJsonReport,
  observedAt: string,
  expiresAt: string,
  explicitRequirements: ProviderConformanceRequirement[]
): Map<string, ProviderConformanceCapabilityResult[]> => {
  const groupedAssertions = new Map<string, VitestAssertion[]>();
  for (const testResult of report.testResults ?? []) {
    for (const assertion of testResult.assertionResults ?? []) {
      const provider = assertionProvider(assertion);
      const capability = assertionCapability(assertion);
      if (!provider || !capability) continue;
      const key = `${provider.name}\u0000${capability}`;
      const assertions = groupedAssertions.get(key) ?? [];
      assertions.push(assertion);
      groupedAssertions.set(key, assertions);
    }
  }
  const results = new Map<string, ProviderConformanceCapabilityResult[]>();
  for (const provider of integrationProviderStatuses) {
    const providerResults: ProviderConformanceCapabilityResult[] = [];
    for (const capability of capabilityNames(provider)) {
      const assertions = groupedAssertions.get(`${provider.name}\u0000${capability}`) ?? [];
      const explicitRequired = explicitRequirements.some((requirement) =>
        requirement.provider === provider.name &&
        requirement.capability === capability &&
        requirement.evidence === "live"
      );
      if (provider.status === "skipped_missing_credentials") {
        providerResults.push(createResult({
          provider,
          capability,
          evidence: "live",
          status: "skipped_missing_credentials",
          observedAt,
          expiresAt,
          required: explicitRequired,
          missingRequirements: provider.missingRequirements
        }));
        continue;
      }
      if (assertions.length === 0) continue;
      const failed = assertions.find((assertion) => assertion.status === "failed");
      const allPassed = assertions.every((assertion) => assertion.status === "passed");
      const durationMs = assertions.reduce((total, assertion) => total + (assertion.duration ?? 0), 0);
      if (allPassed) {
        providerResults.push(createResult({
          provider,
          capability,
          evidence: "live",
          status: "live_passed",
          observedAt,
          expiresAt,
          required: true,
          attempts: assertions.length,
          durationMs
        }));
      } else if (failed) {
        const message = failed.failureMessages?.join("\n") ?? "Live provider capability failed.";
        providerResults.push(createResult({
          provider,
          capability,
          evidence: "live",
          status: "failed",
          observedAt,
          expiresAt,
          required: true,
          attempts: assertions.length,
          durationMs,
          error: {
            code: retryableFailure(message) ? "live_transient_failure" : "live_permanent_failure",
            message: sanitizeFailureSummary(message),
            retryable: retryableFailure(message)
          }
        }));
      }
    }
    results.set(provider.name, providerResults);
  }
  return results;
};

export const createProviderConformanceReport = (input: {
  now?: Date;
  ttlHours?: number;
  offlinePassed?: boolean;
  vitestReport?: VitestJsonReport;
  requirements?: ProviderConformanceRequirement[];
} = {}): ProviderConformanceReport => {
  const now = input.now ?? new Date();
  const observedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + (input.ttlHours ?? 168) * 60 * 60 * 1000).toISOString();
  const requirements = input.requirements ?? [];
  const live = input.vitestReport
    ? liveResults(input.vitestReport, observedAt, expiresAt, requirements)
    : new Map<string, ProviderConformanceCapabilityResult[]>();
  const sha = gitSha();
  const report: ProviderConformanceReport = {
    schemaVersion: PROVIDER_CONFORMANCE_REPORT_SCHEMA_VERSION,
    reportId: `provider-conformance-${sha.slice(0, 12)}-${observedAt.replaceAll(/[-:.]/g, "")}`,
    generatedAt: observedAt,
    expiresAt,
    generator: "scripts/provider-smoke-report.ts",
    source: {
      repository: process.env.GITHUB_REPOSITORY ?? "Zhivex/zhivex-ai-sdk",
      gitSha: sha,
      runtime: `bun ${process.versions.bun ?? "unknown"}; ${process.platform}/${process.arch}`,
      ...(process.env.GITHUB_RUN_ID
        ? {
            ci: {
              system: "github-actions",
              runId: process.env.GITHUB_RUN_ID,
              runAttempt: process.env.GITHUB_RUN_ATTEMPT,
              workflow: process.env.GITHUB_WORKFLOW
            }
          }
        : {})
    },
    providers: integrationProviderStatuses.map((provider) => {
      const results: ProviderConformanceCapabilityResult[] = [];
      for (const capability of capabilityNames(provider)) {
        results.push(createResult({
          provider,
          capability,
          evidence: "declared",
          status: "implemented",
          observedAt,
          expiresAt,
          required: requirements.some((requirement) =>
            requirement.provider === provider.name &&
            requirement.capability === capability &&
            requirement.evidence === "declared"
          )
        }));
        if (input.offlinePassed) {
          results.push(createResult({
            provider,
            capability,
            evidence: "offline",
            status: "offline_passed",
            observedAt,
            expiresAt,
            required: requirements.some((requirement) =>
              requirement.provider === provider.name &&
              requirement.capability === capability &&
              requirement.evidence === "offline"
            ),
            attempts: 1
          }));
        }
      }
      results.push(...(live.get(provider.name) ?? []));
      return { provider: provider.name, results };
    })
  };
  return normalizeProviderConformanceReport(report, { now, applyTtl: true });
};

const readReport = (path: string, applyTtl = true): ProviderConformanceReport =>
  normalizeProviderConformanceReport(
    JSON.parse(readFileSync(resolve(workspaceDirectory, path), "utf8")),
    { applyTtl }
  );

const writeOutput = (path: string, value: string): void => {
  const absolutePath = resolve(workspaceDirectory, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, value, { mode: 0o600 });
};

export const runProviderConformanceCli = (args: string[]): number => {
  const options = parseProviderConformanceCliOptions(args);
  const liveOutcome = options.runLive ? runLiveTests() : undefined;
  const generated = createProviderConformanceReport({
    ttlHours: options.ttlHours,
    offlinePassed: options.offlinePassed,
    vitestReport: liveOutcome?.report,
    requirements: options.requirements
  });
  const reports = [generated, ...options.mergePaths.map(readReport)];
  const report = reports.length === 1 ? generated : mergeProviderConformanceReports(reports);
  const baseline = options.baselinePath ? readReport(options.baselinePath, false) : undefined;
  const gate = evaluateProviderConformanceGate(report, {
    baseline,
    requirements: options.requirements
  });
  const markdown = renderProviderConformanceMarkdown(report);

  if (options.jsonPath) writeOutput(options.jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  if (options.markdownPath) writeOutput(options.markdownPath, markdown);
  if (!options.markdownPath) console.log(markdown);

  if (!gate.ok) {
    const prefix = options.gate === "warn" ? "warning" : "error";
    for (const issue of gate.issues) console.error(`${prefix}: ${issue.message}`);
  }
  if (options.gate === "required" && !gate.ok) return 1;
  if (options.runLive && liveOutcome?.processStatus && liveOutcome.processStatus !== 0) return 1;
  return 0;
};

if (import.meta.main) {
  try {
    process.exitCode = runProviderConformanceCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Provider conformance report failed.");
    process.exitCode = 1;
  }
}
