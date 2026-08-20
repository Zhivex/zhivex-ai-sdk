import { ValidationError } from "./errors.js";
import type { AgentSession } from "./runner.js";
import type { AgentApprovalRequest, AgentStatus, JsonValue } from "./types.js";

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const WORKFLOW_RUN_STATE_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_STATE_RECORD_SCHEMA_VERSION = 1 as const;

export type WorkflowStatus = "running" | "completed" | "waiting_approval" | "failed";
export type WorkflowStepStatus = "pending" | "running" | "completed" | "waiting_approval" | "failed";

export interface WorkflowStepResult {
  id: string;
  kind?: "task" | "parallel" | "loop";
  status: WorkflowStepStatus;
  outputKey?: string;
  outputText?: string;
  runId?: string;
  agentStatus?: AgentStatus;
  approvals?: AgentApprovalRequest[];
  children?: WorkflowStepResult[];
  startedAt?: number;
  finishedAt?: number;
  error?: {
    message: string;
  };
  metadata?: Record<string, JsonValue>;
}

export interface WorkflowRunState {
  schemaVersion: typeof WORKFLOW_RUN_STATE_SCHEMA_VERSION;
  workflowId?: string;
  runId: string;
  userId: string;
  sessionId: string;
  status: WorkflowStatus;
  input?: JsonValue;
  outputs: Record<string, JsonValue>;
  steps: WorkflowStepResult[];
  currentStepIndex: number;
  session?: AgentSession;
  metadata?: Record<string, JsonValue>;
  createdAt: number;
  updatedAt: number;
}

export type PersistedWorkflowRunState = Omit<WorkflowRunState, "session">;
export type WorkflowRunStateMigrationTarget = typeof WORKFLOW_RUN_STATE_SCHEMA_VERSION;

export interface WorkflowStateServiceLookup {
  appName: string;
  userId: string;
  sessionId: string;
  workflowKey: string;
}

export interface WorkflowStateListInput {
  appName: string;
  userId: string;
  sessionId?: string;
  workflowKey?: string;
  status?: WorkflowStatus;
}

export interface WorkflowStateSaveInput extends WorkflowStateServiceLookup {
  state: PersistedWorkflowRunState;
  expectedRevision?: number;
}

export interface WorkflowStateRecord extends WorkflowStateServiceLookup {
  schemaVersion: typeof WORKFLOW_STATE_RECORD_SCHEMA_VERSION;
  revision: number;
  state: PersistedWorkflowRunState;
  status: WorkflowStatus;
  runId: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowStateService {
  saveWorkflowState(input: WorkflowStateSaveInput): Promise<WorkflowStateRecord> | WorkflowStateRecord;
  loadWorkflowState(
    input: WorkflowStateServiceLookup
  ): Promise<WorkflowStateRecord | undefined> | WorkflowStateRecord | undefined;
  listWorkflowStates(input: WorkflowStateListInput): Promise<WorkflowStateRecord[]> | WorkflowStateRecord[];
  deleteWorkflowState(input: WorkflowStateServiceLookup): Promise<void> | void;
}

export const normalizeWorkflowRunState = (value: unknown): WorkflowRunState => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("WorkflowRunState must be an object.");
  }
  const state = value as Partial<WorkflowRunState> & { schemaVersion?: number };
  if (state.schemaVersion !== undefined && state.schemaVersion > WORKFLOW_RUN_STATE_SCHEMA_VERSION) {
    throw new ValidationError(`Unsupported WorkflowRunState schemaVersion ${state.schemaVersion}.`);
  }
  if (
    typeof state.runId !== "string" ||
    typeof state.userId !== "string" ||
    typeof state.sessionId !== "string" ||
    typeof state.status !== "string" ||
    !state.outputs ||
    typeof state.outputs !== "object" ||
    Array.isArray(state.outputs) ||
    !Array.isArray(state.steps) ||
    typeof state.currentStepIndex !== "number" ||
    typeof state.createdAt !== "number" ||
    typeof state.updatedAt !== "number"
  ) {
    throw new ValidationError("WorkflowRunState is missing required fields.");
  }
  return {
    schemaVersion: WORKFLOW_RUN_STATE_SCHEMA_VERSION,
    workflowId: state.workflowId,
    runId: state.runId,
    userId: state.userId,
    sessionId: state.sessionId,
    status: state.status as WorkflowStatus,
    input: state.input === undefined ? undefined : cloneJson(state.input),
    outputs: cloneJson(state.outputs as Record<string, JsonValue>),
    steps: cloneJson(state.steps),
    currentStepIndex: state.currentStepIndex,
    session: state.session ? cloneJson(state.session) : undefined,
    metadata: state.metadata ? cloneJson(state.metadata) : undefined,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt
  };
};

export const migrateWorkflowRunState = (
  value: unknown,
  targetVersion: WorkflowRunStateMigrationTarget = WORKFLOW_RUN_STATE_SCHEMA_VERSION
): WorkflowRunState => {
  if (targetVersion !== WORKFLOW_RUN_STATE_SCHEMA_VERSION) {
    throw new ValidationError(`Unsupported WorkflowRunState migration target ${targetVersion}.`);
  }
  return normalizeWorkflowRunState(value);
};
