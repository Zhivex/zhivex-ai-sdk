import { ConflictError, ValidationError } from "../errors.js";
import { canonicalStoreKey } from "../store-key.js";
import type { PostgresClientLike, SqliteDatabaseLike } from "../types.js";
import {
  normalizeWorkflowRunState,
  WORKFLOW_RUN_STATE_SCHEMA_VERSION,
  WORKFLOW_STATE_RECORD_SCHEMA_VERSION,
  type WorkflowStateListInput,
  type WorkflowStateRecord,
  type WorkflowStateSaveInput,
  type WorkflowStateServiceLookup,
  type WorkflowStatus
} from "../workflow-state-contracts.js";

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface FileWorkflowStateServiceOptions {
  directory: string;
}

export interface FileWorkflowStateStorePruneOptions extends FileWorkflowStateServiceOptions {
  olderThanMs?: number;
  keepLast?: number;
  now?: number;
  dryRun?: boolean;
}

export interface FileWorkflowStateStorePruneResult {
  directory: string;
  dryRun: boolean;
  deletedWorkflowStateKeys: string[];
  keptWorkflowStateKeys: string[];
}

export interface SqliteWorkflowStateServiceOptions {
  db: SqliteDatabaseLike;
  tableName?: string;
}

export interface PostgresWorkflowStateServiceOptions {
  client: PostgresClientLike;
  tableName?: string;
}

export type WorkflowStateRecordMigrationTarget = typeof WORKFLOW_STATE_RECORD_SCHEMA_VERSION;

export type WorkflowStateLookup = WorkflowStateServiceLookup;

export const workflowStateParts = (input: WorkflowStateLookup) =>
  [input.appName, input.userId, input.sessionId, input.workflowKey] as const;

export const workflowStateKey = (input: WorkflowStateLookup): string =>
  canonicalStoreKey("workflow-state", workflowStateParts(input));

export const legacyWorkflowStateKey = (input: WorkflowStateLookup): string =>
  `${input.appName}:${input.userId}:${input.sessionId}:${input.workflowKey}`;

export const matchesWorkflowStateLookup = (record: WorkflowStateRecord, input: WorkflowStateLookup) =>
  record.appName === input.appName &&
  record.userId === input.userId &&
  record.sessionId === input.sessionId &&
  record.workflowKey === input.workflowKey;

export const normalizeWorkflowStateRecord = (value: unknown): WorkflowStateRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("WorkflowStateRecord must be an object.");
  }
  const record = value as Partial<WorkflowStateRecord> & { schemaVersion?: number };
  if (record.schemaVersion !== undefined && record.schemaVersion > WORKFLOW_STATE_RECORD_SCHEMA_VERSION) {
    throw new ValidationError(`Unsupported WorkflowStateRecord schemaVersion ${record.schemaVersion}.`);
  }
  if (
    typeof record.appName !== "string" ||
    typeof record.userId !== "string" ||
    typeof record.sessionId !== "string" ||
    typeof record.workflowKey !== "string" ||
    typeof record.runId !== "string" ||
    typeof record.status !== "string" ||
    typeof record.createdAt !== "number" ||
    typeof record.updatedAt !== "number" ||
    !record.state
  ) {
    throw new ValidationError("WorkflowStateRecord is missing required fields.");
  }
  return {
    schemaVersion: WORKFLOW_STATE_RECORD_SCHEMA_VERSION,
    revision: typeof record.revision === "number" ? record.revision : 1,
    appName: record.appName,
    userId: record.userId,
    sessionId: record.sessionId,
    workflowKey: record.workflowKey,
    state: normalizeWorkflowRunState(record.state),
    status: record.status as WorkflowStatus,
    runId: record.runId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
};

export const migrateWorkflowStateRecord = (
  value: unknown,
  targetVersion: WorkflowStateRecordMigrationTarget = WORKFLOW_STATE_RECORD_SCHEMA_VERSION
): WorkflowStateRecord => {
  if (targetVersion !== WORKFLOW_STATE_RECORD_SCHEMA_VERSION) {
    throw new ValidationError(`Unsupported WorkflowStateRecord migration target ${targetVersion}.`);
  }
  return normalizeWorkflowStateRecord(value);
};

export const assertExpectedRevision = (
  current: { revision: number } | undefined,
  expectedRevision: number | undefined
) => {
  if (expectedRevision !== undefined && (current?.revision ?? 0) !== expectedRevision) {
    throw new ConflictError("WorkflowStateRecord revision conflict.");
  }
};

export const cloneRecord = (record: WorkflowStateRecord): WorkflowStateRecord => cloneJson(normalizeWorkflowStateRecord(record));

export const createRecord = (input: WorkflowStateSaveInput, existing?: WorkflowStateRecord): WorkflowStateRecord => {
  const now = Date.now();
  const state = normalizeWorkflowRunState(input.state);
  return {
    schemaVersion: WORKFLOW_STATE_RECORD_SCHEMA_VERSION,
    revision: existing ? existing.revision + 1 : 1,
    appName: input.appName,
    userId: input.userId,
    sessionId: input.sessionId,
    workflowKey: input.workflowKey,
    state: cloneJson({ ...state, schemaVersion: WORKFLOW_RUN_STATE_SCHEMA_VERSION }),
    status: state.status,
    runId: state.runId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
};

export const matchesListInput = (record: WorkflowStateRecord, input: WorkflowStateListInput): boolean =>
  record.appName === input.appName &&
  record.userId === input.userId &&
  (input.sessionId === undefined || record.sessionId === input.sessionId) &&
  (input.workflowKey === undefined || record.workflowKey === input.workflowKey) &&
  (input.status === undefined || record.status === input.status);

export const validateIdentifier = (value: string, fieldName: string): string => {
  if (!identifierPattern.test(value)) {
    throw new ValidationError(`The "${fieldName}" option must match the SQL identifier pattern [A-Za-z_][A-Za-z0-9_]*.`);
  }
  return value;
};

export const getRecordField = (value: unknown, candidates: string[]): unknown => {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const candidate of candidates) {
    if (candidate in record) {
      return record[candidate];
    }
  }
  return undefined;
};

export const parseWorkflowStateJson = (value: unknown): WorkflowStateRecord | undefined => {
  if (!value) {
    return undefined;
  }
  if (typeof value === "string") {
    return normalizeWorkflowStateRecord(JSON.parse(value) as WorkflowStateRecord);
  }
  return normalizeWorkflowStateRecord(value);
};
