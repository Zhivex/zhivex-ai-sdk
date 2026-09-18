import type {
  AgentStatus,
  AgentStoreScope,
  JsonValue
} from "./common.js";
import type {
  ModelMessage
} from "./messages.js";
import type {
  AgentRunState,
  AgentToolReconciliationRecord
} from "./agent-state.js";

export interface AgentRunStoreScopeOptions {
  /** Fixed scope applied to every key handled by this store instance. */
  scope?: AgentStoreScope;
}

export interface AgentRunLease {
  runId: string;
  ownerId: string;
  expiresAt: number;
}

export interface AgentRunLeaseOptions {
  ownerId: string;
  ttlMs: number;
  /** Injectable clock used by deterministic workers and tests. */
  now?: number;
}

export type AgentToolCallJournalStatus = "pending" | "running" | "completed" | "failed";

export interface AgentToolCallJournalEntry {
  providerToolCallId?: string;
  reconciliation?: AgentToolReconciliationRecord;
  runId: string;
  scope?: AgentStoreScope;
  toolCallId: string;
  toolName: string;
  status: AgentToolCallJournalStatus;
  /** Stable key that must also be forwarded to side-effecting integrations. */
  idempotencyKey: string;
  revision: number;
  input?: JsonValue;
  output?: JsonValue;
  error?: { message: string };
  startedAt?: number;
  completedAt?: number;
  updatedAt: number;
}

export interface AgentToolCallJournalSaveOptions {
  leaseOwnerId?: string;
  expectedRevision?: number;
}

export interface AgentToolExecutionClaimResult {
  claimed: boolean;
  entry: AgentToolCallJournalEntry;
}

export interface AgentRunListOptions {
  agentId?: string;
  parentRunId?: string;
  statuses?: AgentStatus[];
  updatedAfter?: number;
  updatedBefore?: number;
  limit?: number;
  /** Opaque cursor returned by the previous page. */
  cursor?: string;
}

export interface AgentRunPage {
  items: AgentRunState[];
  nextCursor?: string;
}

export interface AgentRunRetentionOptions {
  before: number;
  statuses?: AgentStatus[];
  limit?: number;
}

export interface AgentRunSaveOptions {
  leaseOwnerId?: string;
  expectedRevision?: number;
}

export interface AgentRunClaimResult {
  claimed: boolean;
  state: AgentRunState;
}

export interface AgentRunStore {
  /** Lease ownership is checked atomically with reconciliation writes. */
  reconciliationFencing?: boolean;
  load(runId: string, scope?: AgentStoreScope): Promise<AgentRunState | undefined> | AgentRunState | undefined;
  findByIdempotencyKey?(idempotencyKey: string, scope?: AgentStoreScope): Promise<AgentRunState | undefined> | AgentRunState | undefined;
  findByParentRunId?(parentRunId: string, scope?: AgentStoreScope): Promise<AgentRunState[]> | AgentRunState[];
  /**
   * Atomically reserves an idempotency key for a fresh run. Returns the
   * caller's state when the reservation succeeds, or the already-reserved
   * state when another caller owns the key.
   */
  claimIdempotencyKey?(
    state: AgentRunState & { idempotencyKey: string }
  ): Promise<AgentRunClaimResult> | AgentRunClaimResult;
  save(state: AgentRunState, options?: AgentRunSaveOptions): Promise<void> | void;
  delete?(runId: string, scope?: AgentStoreScope): Promise<void> | void;
  list?(options?: AgentRunListOptions, scope?: AgentStoreScope): Promise<AgentRunPage> | AgentRunPage;
  deleteExpired?(options: AgentRunRetentionOptions, scope?: AgentStoreScope): Promise<number> | number;
  acquireLease?(runId: string, options: AgentRunLeaseOptions, scope?: AgentStoreScope): Promise<AgentRunLease | undefined> | AgentRunLease | undefined;
  renewLease?(runId: string, options: AgentRunLeaseOptions, scope?: AgentStoreScope): Promise<AgentRunLease | undefined> | AgentRunLease | undefined;
  releaseLease?(runId: string, ownerId: string, scope?: AgentStoreScope): Promise<boolean> | boolean;
  loadToolCall?(runId: string, toolCallId: string, scope?: AgentStoreScope): Promise<AgentToolCallJournalEntry | undefined> | AgentToolCallJournalEntry | undefined;
  loadToolExecution?(runId: string, toolCallId: string, scope?: AgentStoreScope): Promise<AgentToolCallJournalEntry | undefined> | AgentToolCallJournalEntry | undefined;
  listToolCalls?(runId: string, scope?: AgentStoreScope): Promise<AgentToolCallJournalEntry[]> | AgentToolCallJournalEntry[];
  saveToolCall?(
    entry: AgentToolCallJournalEntry,
    options?: AgentToolCallJournalSaveOptions
  ): Promise<AgentToolCallJournalEntry> | AgentToolCallJournalEntry;
  claimToolExecution?(
    entry: AgentToolCallJournalEntry
  ): Promise<AgentToolExecutionClaimResult> | AgentToolExecutionClaimResult;
  completeToolExecution?(
    entry: AgentToolCallJournalEntry,
    options: AgentToolCallJournalSaveOptions & { expectedRevision: number }
  ): Promise<AgentToolCallJournalEntry> | AgentToolCallJournalEntry;
}

export interface AgentRunCancellationOptions {
  reason?: string;
  cascade?: boolean;
  mode?: "request" | "final";
  scope?: AgentStoreScope;
}

export interface AgentRunTreeCancellationResult {
  parent?: AgentRunState;
  children: AgentRunState[];
}

export interface AgentMemoryContext {
  runId: string;
  agentId?: string;
  scope?: AgentStoreScope;
  state?: AgentRunState;
  metadata?: Record<string, JsonValue>;
}

export interface AgentMemoryStore {
  load(context: AgentMemoryContext): Promise<ModelMessage[]> | ModelMessage[];
  save?(context: AgentMemoryContext & { state: AgentRunState }): Promise<void> | void;
}

export interface SqliteStatementLike<TResult extends Record<string, unknown> = Record<string, unknown>> {
  run(params?: readonly unknown[] | Record<string, unknown>): unknown;
  get(params?: readonly unknown[] | Record<string, unknown>): TResult | undefined;
  all?(params?: readonly unknown[] | Record<string, unknown>): TResult[];
}

export interface SqliteDatabaseLike {
  exec(sql: string): unknown;
  prepare?<TResult extends Record<string, unknown> = Record<string, unknown>>(sql: string): SqliteStatementLike<TResult>;
  query?<TResult extends Record<string, unknown> = Record<string, unknown>>(sql: string): SqliteStatementLike<TResult>;
}

export interface SqliteAgentRunStoreOptions {
  db: SqliteDatabaseLike;
  tableName?: string;
  scope?: AgentStoreScope;
}

export interface SqliteAgentMemoryStoreOptions {
  db: SqliteDatabaseLike;
  tableName?: string;
  key?: (context: AgentMemoryContext) => string;
  selectMessages?: (state: AgentRunState) => ModelMessage[];
  scope?: AgentStoreScope;
}

export interface PostgresQueryResultLike<TResult extends Record<string, unknown> = Record<string, unknown>> {
  rows: TResult[];
}

export interface PostgresClientLike {
  query<TResult extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<PostgresQueryResultLike<TResult>> | PostgresQueryResultLike<TResult>;
}

export interface PostgresAgentRunStoreOptions {
  client: PostgresClientLike;
  tableName?: string;
  scope?: AgentStoreScope;
}

export interface PostgresAgentMemoryStoreOptions {
  client: PostgresClientLike;
  tableName?: string;
  key?: (context: AgentMemoryContext) => string;
  selectMessages?: (state: AgentRunState) => ModelMessage[];
  scope?: AgentStoreScope;
}
