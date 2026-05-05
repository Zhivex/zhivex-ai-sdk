#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  compareWorkflowEvaluationReports,
  cleanupFileArtifactStore,
  createFileArtifactService,
  createFileWorkflowStateService,
  createWorkflowEvaluationDiffReport,
  createWorkflowEvaluationReport,
  normalizeAgentSession,
  normalizeWorkflowRunState,
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
  type AgentSession,
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
  const [command, subcommand, ...rest] = args;
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
    if (parsed.command === "sessions") {
      return await runSessionsCommand(parsed.subcommand, parsed.flags, io, parsed.positionals);
    }
    if (parsed.command === "artifacts") {
      return await runArtifactsCommand(parsed.subcommand, parsed.flags, io);
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
