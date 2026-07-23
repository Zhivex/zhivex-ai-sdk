import { promises as fs } from "node:fs";
import path from "node:path";

import { resumeAgent, runAgent, streamAgent } from "./agent.js";
import { ConflictError, ValidationError } from "./errors.js";
import { normalizeMessages } from "./generate-text.js";
import { createTextMessage, serializeJsonValue } from "./messages.js";
import { assertPostgresClient } from "./postgres-client.js";
import { createSecureId } from "./secure-id.js";
import type {
  AgentApprovalRequest,
  AgentDefinition,
  AgentRunInput,
  AgentRunOutput,
  AgentRunState,
  AgentStatus,
  AgentStreamEvent,
  JsonValue,
  LanguageModel,
  ModelMessage,
  PostgresClientLike,
  SqliteDatabaseLike,
  SqliteStatementLike
} from "./types.js";

const randomId = createSecureId;

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const SESSION_SCHEMA_VERSION = 1 as const;

export type SessionEventType =
  | "session-created"
  | "user-message"
  | "agent-run-started"
  | "agent-run-finished"
  | "agent-run-failed"
  | "approval-required";

export interface SessionEvent {
  id: string;
  type: SessionEventType;
  appName: string;
  userId: string;
  sessionId: string;
  createdAt: number;
  runId?: string;
  messages?: ModelMessage[];
  status?: AgentStatus;
  outputText?: string;
  approvals?: AgentApprovalRequest[];
  error?: {
    message: string;
  };
  metadata?: Record<string, JsonValue>;
}

export interface AgentSession {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  revision: number;
  appName: string;
  userId: string;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, JsonValue>;
  events: SessionEvent[];
  lastRunState?: AgentRunState;
}

export interface SessionLookup {
  appName: string;
  userId: string;
  sessionId: string;
}

export interface SessionCreateInput extends SessionLookup {
  metadata?: Record<string, JsonValue>;
}

export interface SessionSaveOptions {
  expectedRevision?: number;
}

export interface SessionService {
  loadSession(input: SessionLookup): Promise<AgentSession | undefined> | AgentSession | undefined;
  createSession(input: SessionCreateInput): Promise<AgentSession> | AgentSession;
  saveSession(session: AgentSession, options?: SessionSaveOptions): Promise<void> | void;
  appendEvent(input: SessionLookup & { event: SessionEvent; expectedRevision?: number }): Promise<AgentSession> | AgentSession;
}

export type RunnerRunInput<TModel extends LanguageModel = LanguageModel> = Omit<
  AgentRunInput<TModel>,
  "state" | "handoff" | "parentRunId"
> & {
  userId: string;
  sessionId?: string;
  sessionMetadata?: Record<string, JsonValue>;
  eventMetadata?: Record<string, JsonValue>;
};

export interface RunnerRunOutput {
  session: AgentSession;
  output: AgentRunOutput;
}

export interface RunnerStreamResult {
  session: Promise<AgentSession>;
  eventStream: AsyncIterable<AgentStreamEvent>;
  textStream: AsyncIterable<string>;
  collect: () => Promise<RunnerRunOutput>;
}

export interface Runner<TModel extends LanguageModel = LanguageModel> {
  run(input: RunnerRunInput<TModel>): Promise<RunnerRunOutput>;
  stream(input: RunnerRunInput<TModel>): RunnerStreamResult;
}

export interface CreateRunnerOptions<TModel extends LanguageModel = LanguageModel> {
  appName: string;
  agent: AgentDefinition<TModel>;
  sessionService: SessionService;
  defaults?: Partial<Omit<AgentRunInput<TModel>, "state" | "handoff" | "parentRunId">>;
}

export interface FileSessionServiceOptions {
  directory: string;
}

export interface SqliteSessionServiceOptions {
  db: SqliteDatabaseLike;
  tableName?: string;
}

export interface PostgresSessionServiceOptions {
  client: PostgresClientLike;
  tableName?: string;
}

export interface FileSessionStorePruneOptions extends FileSessionServiceOptions {
  olderThanMs?: number;
  keepLast?: number;
  now?: number;
  dryRun?: boolean;
}

export interface FileSessionStorePruneResult {
  directory: string;
  dryRun: boolean;
  deletedSessionKeys: string[];
  keptSessionKeys: string[];
}

export type AgentSessionMigrationTarget = typeof SESSION_SCHEMA_VERSION;

const sessionKey = (input: SessionLookup) => `${input.appName}:${input.userId}:${input.sessionId}`;
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

const validateIdentifier = (value: string, fieldName: string): string => {
  if (!identifierPattern.test(value)) {
    throw new ValidationError(`The "${fieldName}" option must match the SQL identifier pattern [A-Za-z_][A-Za-z0-9_]*.`);
  }
  return value;
};

const getRecordField = (value: unknown, candidates: string[]): unknown => {
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

const parseSessionJson = (value: unknown): AgentSession | undefined => {
  if (!value) {
    return undefined;
  }

  if (typeof value === "string") {
    return normalizeAgentSession(JSON.parse(value) as AgentSession);
  }

  return normalizeAgentSession(value);
};

export const normalizeAgentSession = (value: unknown): AgentSession => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("AgentSession must be an object.");
  }
  const session = value as Partial<AgentSession> & { schemaVersion?: number };
  if (session.schemaVersion !== undefined && session.schemaVersion > SESSION_SCHEMA_VERSION) {
    throw new ValidationError(`Unsupported AgentSession schemaVersion ${session.schemaVersion}.`);
  }
  if (
    typeof session.appName !== "string" ||
    typeof session.userId !== "string" ||
    typeof session.sessionId !== "string" ||
    typeof session.createdAt !== "number" ||
    typeof session.updatedAt !== "number" ||
    !Array.isArray(session.events)
  ) {
    throw new ValidationError("AgentSession is missing required fields.");
  }
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    revision: typeof session.revision === "number" ? session.revision : 1,
    appName: session.appName,
    userId: session.userId,
    sessionId: session.sessionId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    metadata: session.metadata ? cloneJson(session.metadata) : undefined,
    events: cloneJson(session.events),
    lastRunState: session.lastRunState ? cloneJson(session.lastRunState) : undefined
  };
};

export const migrateAgentSessionRecord = (
  value: unknown,
  targetVersion: AgentSessionMigrationTarget = SESSION_SCHEMA_VERSION
): AgentSession => {
  if (targetVersion !== SESSION_SCHEMA_VERSION) {
    throw new ValidationError(`Unsupported AgentSession migration target ${targetVersion}.`);
  }
  return normalizeAgentSession(value);
};

const assertExpectedRevision = (
  current: { revision: number } | undefined,
  expectedRevision: number | undefined,
  resource: string
) => {
  if (expectedRevision !== undefined && (current?.revision ?? 0) !== expectedRevision) {
    throw new ConflictError(`${resource} revision conflict.`);
  }
};

const sqliteMutationCount = (result: unknown): number | undefined => {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  const value = record.changes ?? record.changeset ?? record.rowCount;
  return typeof value === "number" ? value : undefined;
};

const prepareSqliteStatement = <TResult extends Record<string, unknown>>(
  db: SqliteDatabaseLike,
  sql: string
): SqliteStatementLike<TResult> => {
  if (typeof db.prepare === "function") {
    return db.prepare<TResult>(sql);
  }

  if (typeof db.query === "function") {
    return db.query<TResult>(sql);
  }

  throw new ValidationError('The "db" option must expose either a "prepare()" or "query()" method.');
};

const ensurePostgresTable = (() => {
  const initializedTables = new WeakMap<PostgresClientLike, Map<string, Promise<void>>>();

  return async (client: PostgresClientLike, tableName: string, createSql: string) => {
    let tables = initializedTables.get(client);
    if (!tables) {
      tables = new Map<string, Promise<void>>();
      initializedTables.set(client, tables);
    }

    let initialization = tables.get(tableName);
    if (!initialization) {
      initialization = Promise.resolve(client.query(createSql, [])).then(() => undefined);
      tables.set(tableName, initialization);
    }

    await initialization;
  };
})();

const toSessionEvent = (
  type: SessionEventType,
  input: Omit<SessionEvent, "id" | "type" | "createdAt">
): SessionEvent => ({
  ...input,
  id: randomId("evt"),
  type,
  createdAt: Date.now()
});

const cloneSession = (session: AgentSession): AgentSession => cloneJson(normalizeAgentSession(session));

export const createInMemorySessionService = (): SessionService => {
  const sessions = new Map<string, AgentSession>();

  return {
    loadSession(input) {
      const session = sessions.get(sessionKey(input));
      return session ? cloneSession(session) : undefined;
    },

    createSession(input) {
      const now = Date.now();
      const session: AgentSession = {
        schemaVersion: SESSION_SCHEMA_VERSION,
        revision: 1,
        appName: input.appName,
        userId: input.userId,
        sessionId: input.sessionId,
        createdAt: now,
        updatedAt: now,
        metadata: input.metadata ? cloneJson(input.metadata) : undefined,
        events: []
      };
      sessions.set(sessionKey(input), cloneSession(session));
      return cloneSession(session);
    },

    saveSession(session, options) {
      assertExpectedRevision(sessions.get(sessionKey(session)), options?.expectedRevision, "AgentSession");
      const normalized = normalizeAgentSession({ ...session, updatedAt: Date.now() });
      const current = sessions.get(sessionKey(normalized));
      sessions.set(sessionKey(normalized), cloneSession({
        ...normalized,
        revision: (current?.revision ?? normalized.revision) + 1
      }));
    },

    appendEvent(input) {
      const existing = sessions.get(sessionKey(input));
      const base =
        existing ??
        ({
          schemaVersion: SESSION_SCHEMA_VERSION,
          revision: 1,
          appName: input.appName,
          userId: input.userId,
          sessionId: input.sessionId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          events: []
        } satisfies AgentSession);
      const next = {
        ...base,
        revision: existing ? base.revision + 1 : 1,
        updatedAt: Date.now(),
        events: [...base.events, cloneJson(input.event)]
      };
      assertExpectedRevision(existing, input.expectedRevision, "AgentSession");
      sessions.set(sessionKey(input), cloneSession(next));
      return cloneSession(next);
    }
  };
};

const createEmptySession = (input: SessionCreateInput): AgentSession => {
  const now = Date.now();
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    revision: 1,
    appName: input.appName,
    userId: input.userId,
    sessionId: input.sessionId,
    createdAt: now,
    updatedAt: now,
    metadata: input.metadata ? cloneJson(input.metadata) : undefined,
    events: []
  };
};

const appendEventToSession = (session: AgentSession, event: SessionEvent): AgentSession => ({
  ...normalizeAgentSession(session),
  schemaVersion: SESSION_SCHEMA_VERSION,
  updatedAt: Date.now(),
  events: [...session.events, cloneJson(event)]
});

const fileNameForSession = (input: SessionLookup): string =>
  [input.appName, input.userId, input.sessionId].map((part) => encodeURIComponent(part)).join("__") + ".json";

export const createFileSessionService = (options: FileSessionServiceOptions): SessionService => {
  const filePath = (input: SessionLookup) => path.join(options.directory, fileNameForSession(input));
  const load = async (input: SessionLookup): Promise<AgentSession | undefined> => {
    try {
      const content = await fs.readFile(filePath(input), "utf8");
      return normalizeAgentSession(JSON.parse(content) as AgentSession);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  };
  const save = async (session: AgentSession, saveOptions?: SessionSaveOptions): Promise<void> => {
    const existing = await load(session);
    assertExpectedRevision(existing, saveOptions?.expectedRevision, "AgentSession");
    const next = normalizeAgentSession({ ...session, schemaVersion: SESSION_SCHEMA_VERSION, updatedAt: Date.now() });
    next.revision = existing ? existing.revision + 1 : next.revision;
    await fs.mkdir(options.directory, { recursive: true });
    await fs.writeFile(filePath(next), JSON.stringify(next, null, 2), "utf8");
  };

  return {
    async loadSession(input) {
      return load(input);
    },

    async createSession(input) {
      const session = createEmptySession(input);
      await save(session);
      return cloneSession(session);
    },

    async saveSession(session, options) {
      await save(session, options);
    },

    async appendEvent(input) {
      const existing = await load(input);
      assertExpectedRevision(existing, input.expectedRevision, "AgentSession");
      const base = existing ?? createEmptySession(input);
      const next = appendEventToSession(base, input.event);
      await save(next);
      return cloneSession(next);
    }
  };
};

export const pruneFileSessionStore = async (
  options: FileSessionStorePruneOptions
): Promise<FileSessionStorePruneResult> => {
  const now = options.now ?? Date.now();
  const dryRun = options.dryRun ?? true;
  let entries: string[];
  try {
    entries = await fs.readdir(options.directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { directory: options.directory, dryRun, deletedSessionKeys: [], keptSessionKeys: [] };
    }
    throw error;
  }

  const sessions: Array<{ filePath: string; key: string; updatedAt: number }> = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(options.directory, entry);
    const session = normalizeAgentSession(JSON.parse(await fs.readFile(filePath, "utf8")) as AgentSession);
    sessions.push({
      filePath,
      key: sessionKey(session),
      updatedAt: session.updatedAt
    });
  }

  const sorted = sessions.sort((left, right) => right.updatedAt - left.updatedAt || left.key.localeCompare(right.key));
  const keepByCount = new Set(
    options.keepLast === undefined ? [] : sorted.slice(0, Math.max(0, options.keepLast)).map((session) => session.key)
  );
  const shouldDelete = (session: { key: string; updatedAt: number }) =>
    !keepByCount.has(session.key) &&
    (options.olderThanMs !== undefined ? now - session.updatedAt > options.olderThanMs : options.keepLast !== undefined);

  const deleted = sorted.filter(shouldDelete);
  if (!dryRun) {
    for (const session of deleted) {
      await fs.unlink(session.filePath);
    }
  }

  return {
    directory: options.directory,
    dryRun,
    deletedSessionKeys: deleted.map((session) => session.key),
    keptSessionKeys: sorted.filter((session) => !shouldDelete(session)).map((session) => session.key)
  };
};

export const createSqliteSessionService = (options: SqliteSessionServiceOptions): SessionService => {
  const tableName = validateIdentifier(options.tableName ?? "zhivex_agent_sessions", "tableName");

  options.db.exec(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      session_key TEXT PRIMARY KEY,
      app_name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )
  `);

  const loadStatement = prepareSqliteStatement<{ session_json?: string; sessionJson?: string }>(
    options.db,
    `SELECT session_json FROM ${tableName} WHERE session_key = ?`
  );
  const saveStatement = prepareSqliteStatement(options.db, `
    INSERT INTO ${tableName} (session_key, app_name, user_id, session_id, session_json, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_key) DO UPDATE SET
      app_name = excluded.app_name,
      user_id = excluded.user_id,
      session_id = excluded.session_id,
      session_json = excluded.session_json,
      updated_at_ms = excluded.updated_at_ms
  `);
  const updateCasStatement = prepareSqliteStatement(options.db, `
    UPDATE ${tableName}
    SET app_name = ?,
        user_id = ?,
        session_id = ?,
        session_json = ?,
        updated_at_ms = ?
    WHERE session_key = ?
      AND updated_at_ms = ?
  `);

  const save = (session: AgentSession, saveOptions?: SessionSaveOptions) => {
    const existing = load(session);
    assertExpectedRevision(existing, saveOptions?.expectedRevision, "AgentSession");
    const next = cloneSession({ ...session, updatedAt: Date.now() });
    next.revision = existing ? existing.revision + 1 : next.revision;
    if (saveOptions?.expectedRevision !== undefined && existing) {
      const result = updateCasStatement.run([
        next.appName,
        next.userId,
        next.sessionId,
        JSON.stringify(next),
        next.updatedAt,
        sessionKey(next),
        existing.updatedAt
      ]);
      if (sqliteMutationCount(result) === 0) {
        throw new ConflictError("AgentSession revision conflict.");
      }
    } else {
      saveStatement.run([
        sessionKey(next),
        next.appName,
        next.userId,
        next.sessionId,
        JSON.stringify(next),
        next.updatedAt
      ]);
    }
    return next;
  };
  const load = (input: SessionLookup): AgentSession | undefined => {
    const row = loadStatement.get([sessionKey(input)]);
    return parseSessionJson(getRecordField(row, ["session_json", "sessionJson"]));
  };

  return {
    loadSession(input) {
      return load(input);
    },

    createSession(input) {
      return save(createEmptySession(input));
    },

    saveSession(session, options) {
      save(session, options);
    },

    appendEvent(input) {
      const existing = load(input);
      assertExpectedRevision(existing, input.expectedRevision, "AgentSession");
      const base = existing ?? createEmptySession(input);
      return save(
        appendEventToSession(base, input.event),
        input.expectedRevision === undefined ? undefined : { expectedRevision: input.expectedRevision }
      );
    }
  };
};

export const createPostgresSessionService = (options: PostgresSessionServiceOptions): SessionService => {
  assertPostgresClient(options.client);
  const tableName = validateIdentifier(options.tableName ?? "zhivex_agent_sessions", "tableName");
  const createSql = `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      session_key TEXT PRIMARY KEY,
      app_name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_json JSONB NOT NULL,
      updated_at_ms BIGINT NOT NULL
    )
  `;

  const load = async (input: SessionLookup): Promise<AgentSession | undefined> => {
    await ensurePostgresTable(options.client, tableName, createSql);
    const result = await options.client.query<{ session_json?: AgentSession; sessionJson?: AgentSession }>(
      `SELECT session_json FROM ${tableName} WHERE session_key = $1`,
      [sessionKey(input)]
    );
    return parseSessionJson(getRecordField(result.rows[0], ["session_json", "sessionJson"]));
  };

  const save = async (session: AgentSession, saveOptions?: SessionSaveOptions): Promise<AgentSession> => {
    await ensurePostgresTable(options.client, tableName, createSql);
    const existing = await load(session);
    assertExpectedRevision(existing, saveOptions?.expectedRevision, "AgentSession");
    const next = cloneSession({ ...session, updatedAt: Date.now() });
    next.revision = existing ? existing.revision + 1 : next.revision;
    if (saveOptions?.expectedRevision !== undefined && existing) {
      const result = await options.client.query(
        `UPDATE ${tableName}
         SET app_name = $2,
             user_id = $3,
             session_id = $4,
             session_json = $5::jsonb,
             updated_at_ms = $6
         WHERE session_key = $1
           AND updated_at_ms = $7
         RETURNING session_json`,
        [sessionKey(next), next.appName, next.userId, next.sessionId, JSON.stringify(next), next.updatedAt, existing.updatedAt]
      );
      if (result.rows.length === 0) {
        throw new ConflictError("AgentSession revision conflict.");
      }
    } else {
      await options.client.query(
        `INSERT INTO ${tableName} (session_key, app_name, user_id, session_id, session_json, updated_at_ms)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT(session_key) DO UPDATE SET
           app_name = EXCLUDED.app_name,
           user_id = EXCLUDED.user_id,
           session_id = EXCLUDED.session_id,
           session_json = EXCLUDED.session_json,
           updated_at_ms = EXCLUDED.updated_at_ms`,
        [sessionKey(next), next.appName, next.userId, next.sessionId, JSON.stringify(next), next.updatedAt]
      );
    }
    return next;
  };

  return {
    loadSession(input) {
      return load(input);
    },

    createSession(input) {
      return save(createEmptySession(input));
    },

    async saveSession(session, options) {
      await save(session, options);
    },

    async appendEvent(input) {
      const existing = await load(input);
      assertExpectedRevision(existing, input.expectedRevision, "AgentSession");
      const base = existing ?? createEmptySession(input);
      return save(
        appendEventToSession(base, input.event),
        input.expectedRevision === undefined ? undefined : { expectedRevision: input.expectedRevision }
      );
    }
  };
};

const loadOrCreateSession = async (
  sessionService: SessionService,
  input: SessionCreateInput
): Promise<AgentSession> => {
  const loaded = await sessionService.loadSession(input);
  if (loaded) {
    return loaded;
  }

  await sessionService.createSession(input);
  const event = toSessionEvent("session-created", {
    appName: input.appName,
    userId: input.userId,
    sessionId: input.sessionId,
    metadata: input.metadata
  });
  return sessionService.appendEvent({ ...input, event });
};

const messagesFromSession = (session: AgentSession): ModelMessage[] =>
  session.events.flatMap((event): ModelMessage[] => {
    if (event.type === "user-message") {
      return event.messages ? cloneJson(event.messages) : [];
    }

    if (event.type === "agent-run-finished" && event.outputText) {
      return [createTextMessage("assistant", event.outputText)];
    }

    return [];
  });

const messagesFromInput = (input: RunnerRunInput): ModelMessage[] =>
  normalizeMessages({
    prompt: input.prompt,
    messages: input.messages,
    system: input.system
  });

const appendEvent = async (
  service: SessionService,
  session: AgentSession,
  event: SessionEvent
): Promise<AgentSession> =>
  service.appendEvent({
    appName: session.appName,
    userId: session.userId,
    sessionId: session.sessionId,
    event
  });

const saveRunState = async (
  service: SessionService,
  session: AgentSession,
  state: AgentRunState
): Promise<AgentSession> => {
  const next: AgentSession = {
    ...session,
    updatedAt: Date.now(),
    lastRunState: cloneJson(state)
  };
  await service.saveSession(next);
  return cloneSession(next);
};

const createRunStartedEvent = (session: AgentSession, metadata?: Record<string, JsonValue>): SessionEvent =>
  toSessionEvent("agent-run-started", {
    appName: session.appName,
    userId: session.userId,
    sessionId: session.sessionId,
    metadata
  });

const createRunFinishedEvent = (
  session: AgentSession,
  output: AgentRunOutput,
  metadata?: Record<string, JsonValue>
): SessionEvent =>
  toSessionEvent("agent-run-finished", {
    appName: session.appName,
    userId: session.userId,
    sessionId: session.sessionId,
    runId: output.state.runId,
    status: output.status,
    outputText: output.steps.at(-1)?.response?.text ?? output.outputText,
    metadata
  });

const createRunFailedEvent = (session: AgentSession, error: unknown, metadata?: Record<string, JsonValue>): SessionEvent =>
  toSessionEvent("agent-run-failed", {
    appName: session.appName,
    userId: session.userId,
    sessionId: session.sessionId,
    error: {
      message: error instanceof Error ? error.message : String(error)
    },
    metadata
  });

const createApprovalEvent = (
  session: AgentSession,
  output: AgentRunOutput,
  metadata?: Record<string, JsonValue>
): SessionEvent | undefined => {
  if (!output.state.pendingApprovals.length) {
    return undefined;
  }

  return toSessionEvent("approval-required", {
    appName: session.appName,
    userId: session.userId,
    sessionId: session.sessionId,
    runId: output.state.runId,
    approvals: cloneJson(output.state.pendingApprovals),
    metadata
  });
};

const toSerializableMetadata = (metadata: Record<string, JsonValue> | undefined): Record<string, JsonValue> | undefined =>
  metadata ? (serializeJsonValue(metadata) as Record<string, JsonValue>) : undefined;

export const createRunner = <TModel extends LanguageModel>(
  options: CreateRunnerOptions<TModel>
): Runner<TModel> => {
  const resolveSession = async (input: RunnerRunInput<TModel>) =>
    loadOrCreateSession(options.sessionService, {
      appName: options.appName,
      userId: input.userId,
      sessionId: input.sessionId ?? randomId("sess"),
      metadata: toSerializableMetadata(input.sessionMetadata)
    });

  const createAgentInput = (session: AgentSession, input: RunnerRunInput<TModel>): AgentRunInput<TModel> => {
    const { userId: _userId, sessionId: _sessionId, sessionMetadata: _sessionMetadata, eventMetadata: _eventMetadata, ...agentInput } = input;
    const messages = messagesFromInput(input);

    if (input.approvals?.length && session.lastRunState) {
      return {
        ...options.defaults,
        ...agentInput,
        state: session.lastRunState,
        approvals: input.approvals
      } as AgentRunInput<TModel>;
    }

    return {
      ...options.defaults,
      ...agentInput,
      prompt: undefined,
      system: undefined,
      messages: [...messagesFromSession(session), ...messages]
    } as AgentRunInput<TModel>;
  };

  const recordUserMessage = async (session: AgentSession, input: RunnerRunInput<TModel>): Promise<AgentSession> => {
    if (input.approvals?.length && !input.prompt && !input.messages?.length) {
      return session;
    }

    const messages = messagesFromInput(input).filter((message) => message.role !== "system");
    if (!messages.length) {
      return session;
    }

    return appendEvent(
      options.sessionService,
      session,
      toSessionEvent("user-message", {
        appName: session.appName,
        userId: session.userId,
        sessionId: session.sessionId,
        messages,
        metadata: toSerializableMetadata(input.eventMetadata)
      })
    );
  };

  const finalizeSuccessfulRun = async (
    session: AgentSession,
    output: AgentRunOutput,
    metadata: Record<string, JsonValue> | undefined
  ): Promise<AgentSession> => {
    let next = await appendEvent(options.sessionService, session, createRunFinishedEvent(session, output, metadata));
    const approvalEvent = createApprovalEvent(next, output, metadata);
    if (approvalEvent) {
      next = await appendEvent(options.sessionService, next, approvalEvent);
    }
    return saveRunState(options.sessionService, next, output.state);
  };

  return {
    async run(input) {
      const initialSession = await resolveSession(input);
      let session = await recordUserMessage(initialSession, input);
      session = await appendEvent(options.sessionService, session, createRunStartedEvent(session, toSerializableMetadata(input.eventMetadata)));

      try {
        const agentInput = createAgentInput(initialSession, input);
        const output =
          input.approvals?.length && initialSession.lastRunState
            ? await resumeAgent(options.agent, agentInput as AgentRunInput<TModel> & { state: AgentRunState })
            : await runAgent(options.agent, agentInput);
        const finalSession = await finalizeSuccessfulRun(session, output, toSerializableMetadata(input.eventMetadata));
        return {
          session: finalSession,
          output
        };
      } catch (error) {
        const failedSession = await appendEvent(
          options.sessionService,
          session,
          createRunFailedEvent(session, error, toSerializableMetadata(input.eventMetadata))
        );
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
          session: failedSession
        });
      }
    },

    stream(input) {
      const setup = (async () => {
        const initialSession = await resolveSession(input);
        let session = await recordUserMessage(initialSession, input);
        session = await appendEvent(options.sessionService, session, createRunStartedEvent(session, toSerializableMetadata(input.eventMetadata)));
        const agentInput = createAgentInput(initialSession, input);
        const stream =
          input.approvals?.length && initialSession.lastRunState
            ? streamAgent(options.agent, agentInput as AgentRunInput<TModel> & { state: AgentRunState })
            : streamAgent(options.agent, agentInput);

        return { session, stream };
      })();

      const collect = async (): Promise<RunnerRunOutput> => {
        const { session, stream } = await setup;
        try {
          const output = await stream.collect();
          const finalSession = await finalizeSuccessfulRun(session, output, toSerializableMetadata(input.eventMetadata));
          return { session: finalSession, output };
        } catch (error) {
          const failedSession = await appendEvent(
            options.sessionService,
            session,
            createRunFailedEvent(session, error, toSerializableMetadata(input.eventMetadata))
          );
          throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
            session: failedSession
          });
        }
      };

      return {
        session: setup.then(({ session }) => session),
        eventStream: (async function* () {
          const { stream } = await setup;
          for await (const event of stream.eventStream) {
            yield event;
          }
        })(),
        textStream: (async function* () {
          const { stream } = await setup;
          for await (const chunk of stream.textStream) {
            yield chunk;
          }
        })(),
        collect
      };
    }
  };
};
