#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  compareWorkflowEvaluationReports,
  cleanupFileArtifactStore,
  createAgentRunLedger,
  createFileArtifactService,
  createFileWorkflowStateService,
  createWorkflowEvaluationDiffReport,
  createWorkflowEvaluationReport,
  diffAgentRunLedgers,
  normalizeAgentSession,
  normalizeWorkflowRunState,
  promoteAgentGoldenTrace,
  pruneFileArtifactStore,
  pruneFileSessionStore,
  pruneFileWorkflowStateStore,
  replayWorkflowRun,
  runWorkflow,
  runWorkflowEvaluationFixture,
  saveWorkflowEvaluationReportAsArtifact,
  saveWorkflowReplayAsArtifact,
  inspectFileArtifactStore,
  verifyArtifactIntegrity,
  type AgentRunLedger,
  type AgentRunState,
  type AgentGoldenTrace,
  type AgentSession,
  type JsonValue,
  type WorkflowDefinition,
  type WorkflowEvaluationCase,
  type WorkflowEvaluationFixture,
  type WorkflowEvaluationReport,
  type WorkflowEvaluationResult,
  type WorkflowRunInput,
  type WorkflowRunState
} from "@zhivex-ai/core";

export interface CliIO {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

interface ParsedArgs {
  command?: string;
  subcommand?: string;
  positionals: string[];
  flags: Record<string, string | true>;
}

const printJson = (io: CliIO, value: unknown) => {
  (io.stdout ?? console.log)(JSON.stringify(value, null, 2));
};

const fail = (io: CliIO, message: string): number => {
  (io.stderr ?? console.error)(message);
  return 1;
};

const parseArgs = (args: string[]): ParsedArgs => {
  const [command, ...afterCommand] = args;
  const subcommand = afterCommand[0]?.startsWith("--") ? undefined : afterCommand[0];
  const rest = subcommand ? afterCommand.slice(1) : afterCommand;
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    index += 1;
  }
  return { command, subcommand, positionals, flags };
};

const stringFlag = (flags: Record<string, string | true>, name: string): string | undefined => {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
};

const requiredFlag = (flags: Record<string, string | true>, name: string): string => {
  const value = stringFlag(flags, name);
  if (!value) {
    throw new Error(`Missing required flag --${name}.`);
  }
  return value;
};

const booleanFlag = (flags: Record<string, string | true>, name: string): boolean => flags[name] === true;
const numberFlag = (flags: Record<string, string | true>, name: string): number | undefined => {
  const value = stringFlag(flags, name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Flag --${name} must be a number.`);
  }
  return parsed;
};

const helpText = `zhivex-ai

Commands:
  init agent
  doctor
  agents ledger|inspect|diff|golden|eval
  sessions list|show|workflow-state|prune
  artifacts list|show|verify|inspect|cleanup|prune
  workflow replay|report|compare|run|eval
  workflow-states list|show|prune

Use --dir for local file-backed stores. Output is JSON unless --help is used.`;

const printHelp = (io: CliIO) => {
  (io.stdout ?? console.log)(helpText);
};

const readJsonFile = async <T>(filePath: string): Promise<T> =>
  JSON.parse(await fs.readFile(filePath, "utf8")) as T;

const writeJsonFile = async (filePath: string, value: unknown): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
};

const writeTextFile = async (filePath: string, value: string, force: boolean): Promise<void> => {
  if (!force) {
    try {
      await fs.access(filePath);
      throw new Error(`Refusing to overwrite existing file: ${filePath}. Pass --force to overwrite.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, "utf8");
};

const listJsonFiles = async (directory: string): Promise<string[]> => {
  try {
    const entries = await fs.readdir(directory);
    return entries.filter((entry) => entry.endsWith(".json")).map((entry) => path.join(directory, entry));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
};

const providerTemplates = {
  openai: {
    packageName: "@zhivex-ai/openai",
    factoryName: "createOpenAI",
    envName: "OPENAI_API_KEY",
    defaultModel: "gpt-5"
  },
  xai: {
    packageName: "@zhivex-ai/xai",
    factoryName: "createXAI",
    envName: "XAI_API_KEY",
    defaultModel: "grok-4.5"
  },
  meta: {
    packageName: "@zhivex-ai/meta",
    factoryName: "createMeta",
    envName: "MODEL_API_KEY",
    defaultModel: "muse-spark-1.1"
  },
  anthropic: {
    packageName: "@zhivex-ai/anthropic",
    factoryName: "createAnthropic",
    envName: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-5"
  },
  gemini: {
    packageName: "@zhivex-ai/gemini",
    factoryName: "createGemini",
    envName: "GEMINI_API_KEY",
    defaultModel: "gemini-3.5-flash"
  }
} as const;

type ProviderTemplateName = keyof typeof providerTemplates;

const isProviderTemplateName = (value: string): value is ProviderTemplateName =>
  value in providerTemplates;

const normalizePackageName = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "zhivex-agent";

const agentTemplate = (options: {
  appName: string;
  provider: ProviderTemplateName;
  model: string;
}): string => {
  const provider = providerTemplates[options.provider];
  return `import { promises as fs } from "node:fs";

import {
  applySafetyPolicyToAgent,
  createAgent,
  createFileSessionService,
  createProductionSafetyPolicy,
  createRunner,
  tool
} from "@zhivex-ai/sdk";
import { ${provider.factoryName} } from "${provider.packageName}";
import { z } from "zod";

const provider = ${provider.factoryName}({
  apiKey: process.env.${provider.envName}
});

const baseAgent = createAgent({
  id: "${options.appName}",
  model: provider("${options.model}"),
  instructions: "You are a concise production assistant. Use tools only when they improve confidence.",
  maxSteps: 6,
  tools: {
    lookup_order: tool({
      name: "lookup_order",
      description: "Returns a deterministic local order record for smoke tests.",
      schema: z.object({
        orderId: z.string()
      }),
      execute: async ({ orderId }) => ({
        orderId,
        status: "ready",
        source: "local-fixture"
      })
    })
  }
});

const agent = applySafetyPolicyToAgent(baseAgent, createProductionSafetyPolicy());

const runner = createRunner({
  appName: "${options.appName}",
  agent,
  sessionService: createFileSessionService({
    directory: ".zhivex/sessions"
  })
});

const prompt = process.argv.slice(2).join(" ") || "Check order A-100 and summarize the result.";

const result = await runner.run({
  userId: "local-user",
  sessionId: "local-session",
  prompt,
  eventMetadata: {
    source: "zhivex-ai init agent"
  }
});

await fs.mkdir(".zhivex/runs", { recursive: true });
await fs.writeFile(".zhivex/runs/latest-agent-state.json", JSON.stringify(result.output.state, null, 2), "utf8");

console.log(JSON.stringify({
  sessionId: result.session.sessionId,
  status: result.output.status,
  outputText: result.output.outputText,
  statePath: ".zhivex/runs/latest-agent-state.json"
}, null, 2));
`;
};

const packageTemplate = (options: {
  packageName: string;
  provider: ProviderTemplateName;
}): string => JSON.stringify({
  name: options.packageName,
  private: true,
  type: "module",
  scripts: {
    dev: "bun run src/agent.ts",
    doctor: "zhivex-ai doctor",
    inspect: "zhivex-ai agents inspect --state .zhivex/runs/latest-agent-state.json",
    ledger: "zhivex-ai agents ledger --state .zhivex/runs/latest-agent-state.json --out .zhivex/runs/latest-ledger.json"
  },
  dependencies: {
    "@zhivex-ai/sdk": "latest",
    [providerTemplates[options.provider].packageName]: "latest",
    zod: "^4.4.3"
  },
  devDependencies: {
    "@types/node": "^25.7.0",
    typescript: "^6.0.3"
  }
}, null, 2) + "\n";

const tsconfigTemplate = `${JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    types: ["node"]
  },
  include: ["src/**/*.ts"]
}, null, 2)}
`;

const envTemplate = (provider: ProviderTemplateName): string =>
  `${providerTemplates[provider].envName}=\n`;

const initReadmeTemplate = (options: {
  appName: string;
  provider: ProviderTemplateName;
}): string => `# ${options.appName}

Generated by \`zhivex-ai init agent\`.

\`\`\`bash
bun install
cp .env.example .env
bun run doctor
bun run dev
bun run inspect
\`\`\`

The local run writes \`.zhivex/runs/latest-agent-state.json\`, which can be inspected, converted into a ledger, or promoted into a golden trace with the \`zhivex-ai agents\` commands.
`;

const runInitCommand = async (
  subcommand: string | undefined,
  flags: Record<string, string | true>,
  io: CliIO,
  positionals: string[]
) => {
  if (subcommand !== "agent") {
    return fail(io, "Unknown init command.");
  }

  const rawProvider = stringFlag(flags, "provider") ?? "openai";
  if (!isProviderTemplateName(rawProvider)) {
    return fail(io, `Unsupported provider "${rawProvider}". Supported providers: ${Object.keys(providerTemplates).join(", ")}.`);
  }

  const directory = path.resolve(stringFlag(flags, "dir") ?? positionals[0] ?? "zhivex-agent");
  const appName = normalizePackageName(stringFlag(flags, "name") ?? path.basename(directory));
  const packageName = normalizePackageName(stringFlag(flags, "package-name") ?? appName);
  const model = stringFlag(flags, "model") ?? providerTemplates[rawProvider].defaultModel;
  const force = booleanFlag(flags, "force");

  const files = [
    ["package.json", packageTemplate({ packageName, provider: rawProvider })],
    ["tsconfig.json", tsconfigTemplate],
    [".env.example", envTemplate(rawProvider)],
    ["README.md", initReadmeTemplate({ appName, provider: rawProvider })],
    [path.join("src", "agent.ts"), agentTemplate({ appName, provider: rawProvider, model })],
    [path.join(".zhivex", ".gitignore"), "*\n!.gitignore\n"]
  ] as const;

  for (const [relativePath, contents] of files) {
    await writeTextFile(path.join(directory, relativePath), contents, force);
  }

  printJson(io, {
    ok: true,
    type: "agent_project",
    directory,
    appName,
    provider: rawProvider,
    model,
    files: files.map(([relativePath]) => relativePath)
  });
  return 0;
};

type DoctorCheckStatus = "pass" | "warn" | "fail";

interface DoctorCheck {
  name: string;
  status: DoctorCheckStatus;
  detail: string;
}

const parsePackageJson = async (directory: string): Promise<Record<string, unknown> | undefined> => {
  try {
    return await readJsonFile<Record<string, unknown>>(path.join(directory, "package.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};

const packageHasDependency = (pkg: Record<string, unknown> | undefined, dependencyName: string): boolean => {
  const dependencyBlocks = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  return dependencyBlocks.some((block) => {
    const dependencies = pkg?.[block];
    return Boolean(
      dependencies &&
      typeof dependencies === "object" &&
      !Array.isArray(dependencies) &&
      dependencyName in dependencies
    );
  });
};

const pathExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const runDoctorCommand = async (
  flags: Record<string, string | true>,
  io: CliIO
) => {
  const directory = path.resolve(stringFlag(flags, "dir") ?? process.cwd());
  const provider = stringFlag(flags, "provider");
  const pkg = await parsePackageJson(directory);
  const checks: DoctorCheck[] = [];
  const runtime = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`;

  checks.push({
    name: "runtime",
    status: process.versions.bun || Number(process.versions.node.split(".")[0]) >= 18 ? "pass" : "fail",
    detail: runtime
  });
  checks.push({
    name: "package-json",
    status: pkg ? "pass" : "fail",
    detail: pkg ? path.join(directory, "package.json") : "package.json not found"
  });
  checks.push({
    name: "sdk-dependency",
    status: packageHasDependency(pkg, "@zhivex-ai/sdk") ? "pass" : "fail",
    detail: packageHasDependency(pkg, "@zhivex-ai/sdk") ? "@zhivex-ai/sdk is declared" : "Add @zhivex-ai/sdk to dependencies"
  });

  const providerNames = provider && isProviderTemplateName(provider)
    ? [provider]
    : Object.keys(providerTemplates).filter((name): name is ProviderTemplateName =>
      packageHasDependency(pkg, providerTemplates[name as ProviderTemplateName].packageName)
    );

  if (provider && !isProviderTemplateName(provider)) {
    checks.push({
      name: "provider",
      status: "fail",
      detail: `Unsupported provider "${provider}".`
    });
  }

  if (!providerNames.length) {
    checks.push({
      name: "provider-dependency",
      status: "warn",
      detail: "No supported provider dependency detected."
    });
  }

  for (const providerName of providerNames) {
    const template = providerTemplates[providerName];
    checks.push({
      name: `${providerName}-dependency`,
      status: packageHasDependency(pkg, template.packageName) ? "pass" : "fail",
      detail: packageHasDependency(pkg, template.packageName)
        ? `${template.packageName} is declared`
        : `Add ${template.packageName} to dependencies`
    });
    checks.push({
      name: `${providerName}-env`,
      status: process.env[template.envName] ? "pass" : "warn",
      detail: process.env[template.envName]
        ? `${template.envName} is set`
        : `${template.envName} is not set`
    });
  }

  checks.push({
    name: "typescript-config",
    status: await pathExists(path.join(directory, "tsconfig.json")) ? "pass" : "warn",
    detail: await pathExists(path.join(directory, "tsconfig.json"))
      ? "tsconfig.json found"
      : "tsconfig.json not found"
  });
  checks.push({
    name: "local-session-store",
    status: await pathExists(path.join(directory, ".zhivex", "sessions")) ? "pass" : "warn",
    detail: await pathExists(path.join(directory, ".zhivex", "sessions"))
      ? ".zhivex/sessions found"
      : ".zhivex/sessions will be created after the first file-backed run"
  });

  printJson(io, {
    ok: checks.every((check) => check.status !== "fail"),
    type: "doctor_report",
    directory,
    checks
  });
  return 0;
};

const isSession = (value: unknown): value is AgentSession => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<AgentSession>;
  return (
    typeof record.appName === "string" &&
    typeof record.userId === "string" &&
    typeof record.sessionId === "string" &&
    Array.isArray(record.events)
  );
};

const readSessions = async (directory: string): Promise<AgentSession[]> => {
  const sessions: AgentSession[] = [];
  for (const filePath of await listJsonFiles(directory)) {
    const parsed = await readJsonFile<unknown>(filePath);
    if (isSession(parsed)) {
      sessions.push(normalizeAgentSession(parsed));
    }
  }
  return sessions.sort((left, right) =>
    left.appName.localeCompare(right.appName) ||
    left.userId.localeCompare(right.userId) ||
    left.sessionId.localeCompare(right.sessionId)
  );
};

const findSession = async (
  directory: string,
  appName: string,
  userId: string,
  sessionId: string
): Promise<AgentSession | undefined> =>
  (await readSessions(directory)).find(
    (candidate) =>
      candidate.appName === appName &&
      candidate.userId === userId &&
      candidate.sessionId === sessionId
  );

const workflowRunsFromSession = (session: AgentSession): Record<string, unknown> => {
  const workflowRuns = session.metadata?.workflowRuns;
  return workflowRuns && typeof workflowRuns === "object" && !Array.isArray(workflowRuns)
    ? workflowRuns as Record<string, unknown>
    : {};
};

const readAgentLedgerFromFlags = async (flags: Record<string, string | true>): Promise<AgentRunLedger> => {
  const ledgerPath = stringFlag(flags, "ledger");
  if (ledgerPath) {
    return await readJsonFile<AgentRunLedger>(ledgerPath);
  }
  const state = await readJsonFile<AgentRunState>(requiredFlag(flags, "state"));
  return createAgentRunLedger(state, {
    includeTimeline: !booleanFlag(flags, "no-timeline")
  });
};

const inspectAgentLedger = (ledger: AgentRunLedger) => ({
  type: "agent_run_inspection",
  ok: ledger.status === "completed" && ledger.audit.toolErrors === 0,
  runId: ledger.runId,
  agentId: ledger.agentId,
  provider: ledger.provider,
  modelId: ledger.modelId,
  status: ledger.status,
  steps: ledger.audit.steps,
  toolCalls: ledger.audit.toolCalls,
  toolErrors: ledger.audit.toolErrors,
  approvals: ledger.audit.approvals,
  childRuns: ledger.audit.childRuns,
  usage: ledger.audit.usage,
  cost: ledger.cost,
  outputPreview: ledger.audit.outputPreview,
  summary: ledger.summary,
  warnings: [
    ...(ledger.status !== "completed" ? [`Run status is ${ledger.status}.`] : []),
    ...(ledger.audit.toolErrors > 0 ? [`Run has ${ledger.audit.toolErrors} tool error(s).`] : []),
    ...(ledger.audit.approvals > 0 ? [`Run has ${ledger.audit.approvals} pending approval(s).`] : [])
  ]
});

const evaluateGoldenTrace = (golden: AgentGoldenTrace, ledger: AgentRunLedger) => {
  const failures: string[] = [];
  const expectedToolCalls = golden.expectations.toolCalls;
  const actualToolCalls = ledger.snapshot.toolCalls.map((call) => call.name);

  if (golden.expectations.status !== ledger.status) {
    failures.push(`Expected status ${golden.expectations.status}, got ${ledger.status}.`);
  }
  if (
    golden.expectations.outputText !== undefined &&
    golden.expectations.outputText !== ledger.snapshot.outputText
  ) {
    failures.push("Output text did not match the golden trace.");
  }
  if (JSON.stringify(expectedToolCalls) !== JSON.stringify(actualToolCalls)) {
    failures.push(`Expected tool calls ${JSON.stringify(expectedToolCalls)}, got ${JSON.stringify(actualToolCalls)}.`);
  }
  if (golden.expectations.approvals !== ledger.audit.approvals) {
    failures.push(`Expected ${golden.expectations.approvals} approval(s), got ${ledger.audit.approvals}.`);
  }

  return {
    type: "agent_golden_trace_evaluation",
    ok: failures.length === 0,
    name: golden.name,
    runId: ledger.runId,
    expected: golden.expectations,
    actual: {
      status: ledger.status,
      outputText: ledger.snapshot.outputText,
      toolCalls: actualToolCalls,
      approvals: ledger.audit.approvals
    },
    failures
  };
};

const runSessionsCommand = async (
  subcommand: string | undefined,
  flags: Record<string, string | true>,
  io: CliIO,
  positionals: string[]
) => {
  const directory = requiredFlag(flags, "dir");
  if (subcommand === "list") {
    printJson(io, await readSessions(directory));
    return 0;
  }

  if (subcommand === "show") {
    const appName = requiredFlag(flags, "app");
    const userId = requiredFlag(flags, "user");
    const sessionId = requiredFlag(flags, "session");
    const session = await findSession(directory, appName, userId, sessionId);
    if (!session) {
      return fail(io, "Session not found.");
    }
    printJson(io, session);
    return 0;
  }

  if (subcommand === "workflow-state" && positionals[0] === "show") {
    const appName = requiredFlag(flags, "app");
    const userId = requiredFlag(flags, "user");
    const sessionId = requiredFlag(flags, "session");
    const session = await findSession(directory, appName, userId, sessionId);
    if (!session) {
      return fail(io, "Session not found.");
    }
    const workflowRuns = workflowRunsFromSession(session);
    const workflowKey = stringFlag(flags, "workflow");
    if (workflowKey) {
      const state = workflowRuns[workflowKey];
      if (!state) {
        return fail(io, "Workflow state not found.");
      }
      printJson(io, state);
      return 0;
    }
    printJson(io, workflowRuns);
    return 0;
  }

  if (subcommand === "prune") {
    printJson(io, await pruneFileSessionStore({
      directory,
      olderThanMs: numberFlag(flags, "older-than-ms"),
      keepLast: numberFlag(flags, "keep-last"),
      dryRun: !booleanFlag(flags, "execute")
    }));
    return 0;
  }

  return fail(io, "Unknown sessions command.");
};

const runArtifactsCommand = async (subcommand: string | undefined, flags: Record<string, string | true>, io: CliIO) => {
  const directory = requiredFlag(flags, "dir");

  if (subcommand === "inspect") {
    printJson(io, await inspectFileArtifactStore({ directory }));
    return 0;
  }

  if (subcommand === "cleanup") {
    printJson(io, await cleanupFileArtifactStore({ directory, dryRun: booleanFlag(flags, "dry-run") }));
    return 0;
  }

  if (subcommand === "prune") {
    printJson(io, await pruneFileArtifactStore({
      directory,
      olderThanMs: numberFlag(flags, "older-than-ms"),
      keepLast: numberFlag(flags, "keep-last"),
      dryRun: !booleanFlag(flags, "execute")
    }));
    return 0;
  }

  const service = createFileArtifactService({ directory });
  const base = {
    appName: requiredFlag(flags, "app"),
    userId: requiredFlag(flags, "user"),
    sessionId: requiredFlag(flags, "session")
  };

  if (subcommand === "list") {
    printJson(io, await service.listArtifacts({
      ...base,
      workflowRunId: stringFlag(flags, "workflow-run"),
      workflowStepId: stringFlag(flags, "workflow-step"),
      agentRunId: stringFlag(flags, "agent-run")
    }));
    return 0;
  }

  if (subcommand === "show") {
    const artifact = await service.loadArtifact({
      ...base,
      id: requiredFlag(flags, "id")
    });
    if (!artifact) {
      return fail(io, "Artifact not found.");
    }
    printJson(io, artifact);
    return 0;
  }

  if (subcommand === "verify") {
    printJson(io, await verifyArtifactIntegrity(service, {
      ...base,
      id: requiredFlag(flags, "id")
    }));
    return 0;
  }

  return fail(io, "Unknown artifacts command.");
};

const runAgentsCommand = async (subcommand: string | undefined, flags: Record<string, string | true>, io: CliIO) => {
  if (subcommand === "ledger") {
    const ledger = await readAgentLedgerFromFlags(flags);
    const outputPath = stringFlag(flags, "out");
    if (outputPath) {
      await writeJsonFile(outputPath, ledger);
    }
    printJson(io, ledger);
    return 0;
  }

  if (subcommand === "inspect") {
    const inspection = inspectAgentLedger(await readAgentLedgerFromFlags(flags));
    const outputPath = stringFlag(flags, "out");
    if (outputPath) {
      await writeJsonFile(outputPath, inspection);
    }
    printJson(io, inspection);
    return 0;
  }

  if (subcommand === "diff") {
    const base = await readJsonFile<AgentRunLedger>(requiredFlag(flags, "base"));
    const target = await readJsonFile<AgentRunLedger>(requiredFlag(flags, "target"));
    const diff = diffAgentRunLedgers(base, target);
    const outputPath = stringFlag(flags, "out");
    if (outputPath) {
      await writeJsonFile(outputPath, diff);
    }
    printJson(io, diff);
    return 0;
  }

  if (subcommand === "golden") {
    const ledger = await readJsonFile<AgentRunLedger>(requiredFlag(flags, "ledger"));
    const golden = promoteAgentGoldenTrace(ledger, {
      name: stringFlag(flags, "name"),
      outputText: stringFlag(flags, "output"),
      metadata: stringFlag(flags, "metadata")
        ? await readJsonFile<Record<string, JsonValue>>(requiredFlag(flags, "metadata"))
        : undefined
    });
    const outputPath = stringFlag(flags, "out");
    if (outputPath) {
      await writeJsonFile(outputPath, golden);
    }
    printJson(io, golden);
    return 0;
  }

  if (subcommand === "eval") {
    const golden = await readJsonFile<AgentGoldenTrace>(requiredFlag(flags, "golden"));
    const report = evaluateGoldenTrace(golden, await readAgentLedgerFromFlags(flags));
    const outputPath = stringFlag(flags, "out");
    if (outputPath) {
      await writeJsonFile(outputPath, report);
    }
    printJson(io, report);
    return 0;
  }

  return fail(io, "Unknown agents command.");
};

const loadModuleExport = async <T>(
  modulePath: string,
  exportName: string | undefined,
  fallbackName = "default"
): Promise<T> => {
  const module = await import(pathToFileURL(path.resolve(modulePath)).href);
  const key = exportName ?? fallbackName;
  const value = module[key];
  if (value === undefined) {
    throw new Error(`Module export "${key}" not found.`);
  }
  return value as T;
};

const runWorkflowStatesCommand = async (
  subcommand: string | undefined,
  flags: Record<string, string | true>,
  io: CliIO
) => {
  const directory = requiredFlag(flags, "dir");
  if (subcommand === "prune") {
    printJson(io, await pruneFileWorkflowStateStore({
      directory,
      olderThanMs: numberFlag(flags, "older-than-ms"),
      keepLast: numberFlag(flags, "keep-last"),
      dryRun: !booleanFlag(flags, "execute")
    }));
    return 0;
  }

  const service = createFileWorkflowStateService({ directory });
  const base = {
    appName: requiredFlag(flags, "app"),
    userId: requiredFlag(flags, "user")
  };

  if (subcommand === "list") {
    printJson(io, await service.listWorkflowStates({
      ...base,
      sessionId: stringFlag(flags, "session")
    }));
    return 0;
  }

  if (subcommand === "show") {
    const record = await service.loadWorkflowState({
      ...base,
      sessionId: requiredFlag(flags, "session"),
      workflowKey: requiredFlag(flags, "workflow")
    });
    if (!record) {
      return fail(io, "Workflow state not found.");
    }
    printJson(io, record);
    return 0;
  }

  return fail(io, "Unknown workflow-states command.");
};

const runWorkflowCommand = async (subcommand: string | undefined, flags: Record<string, string | true>, io: CliIO) => {
  if (subcommand === "run") {
    const workflow = await loadModuleExport<WorkflowDefinition>(
      requiredFlag(flags, "module"),
      stringFlag(flags, "export")
    );
    const input = await readJsonFile<WorkflowRunInput>(requiredFlag(flags, "input"));
    const output = await runWorkflow(workflow, input);
    const stateOut = stringFlag(flags, "state-out");
    const outputOut = stringFlag(flags, "output-out");
    if (stateOut) {
      await writeJsonFile(stateOut, output.state);
    }
    if (outputOut) {
      await writeJsonFile(outputOut, output);
    }
    printJson(io, output);
    return 0;
  }

  if (subcommand === "eval") {
    const workflow = await loadModuleExport<
      WorkflowDefinition | ((testCase: WorkflowEvaluationCase) => WorkflowDefinition | Promise<WorkflowDefinition>)
    >(
      requiredFlag(flags, "module"),
      stringFlag(flags, "workflow-export")
    );
    const fixture = await readJsonFile<WorkflowEvaluationFixture>(requiredFlag(flags, "fixture"));
    const evaluation = await runWorkflowEvaluationFixture(fixture, { workflow });
    const report = createWorkflowEvaluationReport(evaluation);
    const reportOut = stringFlag(flags, "report-out");
    if (reportOut) {
      await writeJsonFile(reportOut, report);
    }
    printJson(io, report);
    return 0;
  }

  if (subcommand === "replay") {
    const saveArtifact = booleanFlag(flags, "save-artifact");
    const artifactsDirectory = saveArtifact ? requiredFlag(flags, "artifacts-dir") : undefined;
    const appName = saveArtifact ? requiredFlag(flags, "app") : undefined;
    const state = normalizeWorkflowRunState(await readJsonFile<WorkflowRunState>(requiredFlag(flags, "state")));
    if (saveArtifact) {
      const artifact = await saveWorkflowReplayAsArtifact(state, {
        artifactService: createFileArtifactService({ directory: artifactsDirectory! }),
        appName: appName!,
        userId: stringFlag(flags, "user"),
        sessionId: stringFlag(flags, "session"),
        name: stringFlag(flags, "name")
      });
      printJson(io, artifact);
      return 0;
    }
    printJson(io, replayWorkflowRun(state));
    return 0;
  }

  if (subcommand === "report") {
    const saveArtifact = booleanFlag(flags, "save-artifact");
    const artifactsDirectory = saveArtifact ? requiredFlag(flags, "artifacts-dir") : undefined;
    const appName = saveArtifact ? requiredFlag(flags, "app") : undefined;
    const userId = saveArtifact ? requiredFlag(flags, "user") : undefined;
    const sessionId = saveArtifact ? requiredFlag(flags, "session") : undefined;
    const evaluation = await readJsonFile<WorkflowEvaluationResult>(requiredFlag(flags, "evaluation"));
    const report = createWorkflowEvaluationReport(evaluation);
    if (saveArtifact) {
      const artifact = await saveWorkflowEvaluationReportAsArtifact(report, {
        artifactService: createFileArtifactService({ directory: artifactsDirectory! }),
        appName: appName!,
        userId,
        sessionId,
        name: stringFlag(flags, "name"),
        workflowRunId: stringFlag(flags, "workflow-run")
      });
      printJson(io, artifact);
      return 0;
    }
    printJson(io, report);
    return 0;
  }

  if (subcommand === "compare") {
    const base = await readJsonFile<WorkflowEvaluationReport>(requiredFlag(flags, "base"));
    const target = await readJsonFile<WorkflowEvaluationReport>(requiredFlag(flags, "target"));
    printJson(io, createWorkflowEvaluationDiffReport(compareWorkflowEvaluationReports(base, target)));
    return 0;
  }

  return fail(io, "Unknown workflow command.");
};

export const runCli = async (args: string[], io: CliIO = {}): Promise<number> => {
  const parsed = parseArgs(args);
  try {
    if (args.includes("--help") || parsed.command === "help" || !parsed.command) {
      printHelp(io);
      return 0;
    }
    if (parsed.command === "init") {
      return await runInitCommand(parsed.subcommand, parsed.flags, io, parsed.positionals);
    }
    if (parsed.command === "doctor") {
      return await runDoctorCommand(parsed.flags, io);
    }
    if (parsed.command === "sessions") {
      return await runSessionsCommand(parsed.subcommand, parsed.flags, io, parsed.positionals);
    }
    if (parsed.command === "artifacts") {
      return await runArtifactsCommand(parsed.subcommand, parsed.flags, io);
    }
    if (parsed.command === "agents") {
      return await runAgentsCommand(parsed.subcommand, parsed.flags, io);
    }
    if (parsed.command === "workflow-states") {
      return await runWorkflowStatesCommand(parsed.subcommand, parsed.flags, io);
    }
    if (parsed.command === "workflow") {
      return await runWorkflowCommand(parsed.subcommand, parsed.flags, io);
    }

    return fail(io, "Unknown command.");
  } catch (error) {
    return fail(io, error instanceof Error ? error.message : String(error));
  }
};

const invokedPath = process.argv[1]
  ? await fs.realpath(process.argv[1]).catch(() => process.argv[1])
  : undefined;

if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
