/** Compatibility facade. Backend implementations live in dedicated internal modules. */
export { WORKFLOW_STATE_RECORD_SCHEMA_VERSION } from "./workflow-state-contracts.js";
export type {
  WorkflowStateListInput,
  WorkflowStateRecord,
  WorkflowStateSaveInput,
  WorkflowStateService,
  WorkflowStateServiceLookup as WorkflowStateLookup
} from "./workflow-state-contracts.js";
export {
  type FileWorkflowStateServiceOptions,
  type FileWorkflowStateStorePruneOptions,
  type FileWorkflowStateStorePruneResult,
  type SqliteWorkflowStateServiceOptions,
  type PostgresWorkflowStateServiceOptions,
  type WorkflowStateRecordMigrationTarget,
  normalizeWorkflowStateRecord,
  migrateWorkflowStateRecord
} from "./workflow-state-service/shared.js";
export {
  createInMemoryWorkflowStateService
} from "./workflow-state-service/memory.js";
export {
  createFileWorkflowStateService,
  pruneFileWorkflowStateStore
} from "./workflow-state-service/file.js";
export {
  createSqliteWorkflowStateService
} from "./workflow-state-service/sqlite.js";
export {
  createPostgresWorkflowStateService
} from "./workflow-state-service/postgres.js";
