import type { ArtifactRecord, ArtifactService } from "./artifact.js";
import { createWorkflowEvaluationReport, type WorkflowEvaluationReport, type WorkflowEvaluationResult } from "./workflow-evaluation.js";
import {
  replayWorkflowRun,
  type WorkflowReplayResult,
  type WorkflowRunOutput,
  type WorkflowRunState,
  type WorkflowStepResult
} from "./workflow.js";
import type { JsonValue } from "./types.js";

export interface WorkflowArtifactContext {
  artifactService: ArtifactService;
  appName: string;
  userId?: string;
  sessionId?: string;
  metadata?: Record<string, JsonValue>;
}

export interface SaveWorkflowOutputsAsArtifactsOptions extends WorkflowArtifactContext {
  namePrefix?: string;
  contentType?: string;
}

export interface SaveWorkflowReplayAsArtifactOptions extends WorkflowArtifactContext {
  name?: string;
  contentType?: string;
}

export interface SaveWorkflowEvaluationReportAsArtifactOptions extends WorkflowArtifactContext {
  name?: string;
  contentType?: string;
  workflowRunId?: string;
}

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const isWorkflowRunOutput = (value: WorkflowRunOutput | WorkflowRunState): value is WorkflowRunOutput =>
  "state" in value && "outputs" in value && "steps" in value;

const isWorkflowEvaluationResult = (
  value: WorkflowEvaluationResult | WorkflowEvaluationReport
): value is WorkflowEvaluationResult => {
  const candidate = value as { cases?: unknown; passed?: unknown };
  return Array.isArray(candidate.cases) && typeof candidate.passed !== "number";
};

const flattenSteps = (steps: WorkflowStepResult[]): WorkflowStepResult[] =>
  steps.flatMap((step) => [step, ...flattenSteps(step.children ?? [])]);

const stepIdByOutputKey = (state: WorkflowRunState): Map<string, string> => {
  const map = new Map<string, string>();
  for (const step of flattenSteps(state.steps)) {
    if (step.outputKey && !map.has(step.outputKey)) {
      map.set(step.outputKey, step.id);
    }
  }
  return map;
};

const resolveArtifactIdentity = (
  state: WorkflowRunState | undefined,
  context: WorkflowArtifactContext
): { userId: string; sessionId: string } => {
  const userId = context.userId ?? state?.userId;
  const sessionId = context.sessionId ?? state?.sessionId;
  if (!userId) {
    throw new Error("Workflow artifact helpers require userId.");
  }
  if (!sessionId) {
    throw new Error("Workflow artifact helpers require sessionId.");
  }
  return { userId, sessionId };
};

const metadataWithKind = (
  kind: string,
  metadata: Record<string, JsonValue> | undefined,
  extra: Record<string, JsonValue> = {}
): Record<string, JsonValue> => ({
  ...(metadata ? cloneJson(metadata) : {}),
  kind,
  ...extra
});

export const saveWorkflowOutputsAsArtifacts = async (
  output: WorkflowRunOutput,
  options: SaveWorkflowOutputsAsArtifactsOptions
): Promise<ArtifactRecord[]> => {
  const identity = resolveArtifactIdentity(output.state, options);
  const stepIds = stepIdByOutputKey(output.state);
  const artifacts: ArtifactRecord[] = [];

  for (const [outputKey, value] of Object.entries(output.outputs)) {
    const stepId = stepIds.get(outputKey);
    artifacts.push(await options.artifactService.saveArtifact({
      appName: options.appName,
      userId: identity.userId,
      sessionId: identity.sessionId,
      workflowRunId: output.state.runId,
      workflowStepId: stepId,
      name: `${options.namePrefix ?? "workflow-output"}-${outputKey}.json`,
      contentType: options.contentType ?? "application/json",
      data: value,
      metadata: metadataWithKind("workflow-output", options.metadata, { outputKey })
    }));
  }

  return artifacts;
};

export const saveWorkflowReplayAsArtifact = async (
  outputOrState: WorkflowRunOutput | WorkflowRunState,
  options: SaveWorkflowReplayAsArtifactOptions
): Promise<ArtifactRecord> => {
  const state = isWorkflowRunOutput(outputOrState) ? outputOrState.state : outputOrState;
  const identity = resolveArtifactIdentity(state, options);
  const replay: WorkflowReplayResult = replayWorkflowRun(state);

  return options.artifactService.saveArtifact({
    appName: options.appName,
    userId: identity.userId,
    sessionId: identity.sessionId,
    workflowRunId: state.runId,
    name: options.name ?? "workflow-replay.json",
    contentType: options.contentType ?? "application/json",
    data: replay as unknown as JsonValue,
    metadata: metadataWithKind("workflow-replay", options.metadata)
  });
};

export const saveWorkflowEvaluationReportAsArtifact = async (
  resultOrReport: WorkflowEvaluationResult | WorkflowEvaluationReport,
  options: SaveWorkflowEvaluationReportAsArtifactOptions
): Promise<ArtifactRecord> => {
  const report = isWorkflowEvaluationResult(resultOrReport)
    ? createWorkflowEvaluationReport(resultOrReport)
    : resultOrReport;
  const identity = resolveArtifactIdentity(undefined, options);

  return options.artifactService.saveArtifact({
    appName: options.appName,
    userId: identity.userId,
    sessionId: identity.sessionId,
    workflowRunId: options.workflowRunId,
    name: options.name ?? "workflow-evaluation-report.json",
    contentType: options.contentType ?? "application/json",
    data: report as unknown as JsonValue,
    metadata: metadataWithKind("workflow-evaluation-report", options.metadata)
  });
};
