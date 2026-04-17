import { promises as fs } from "node:fs";
import path from "node:path";

import { ValidationError } from "./errors.js";
import type {
  AgentMemoryContext,
  AgentMemoryStore,
  AgentRunState,
  AgentRunStore,
  ModelMessage,
  PostgresAgentMemoryStoreOptions,
  PostgresAgentRunStoreOptions,
  PostgresClientLike,
  SqliteAgentMemoryStoreOptions,
  SqliteAgentRunStoreOptions,
  SqliteDatabaseLike,
  SqliteStatementLike
} from "./types.js";

const cloneState = (state: AgentRunState): AgentRunState => JSON.parse(JSON.stringify(state)) as AgentRunState;
const cloneMessages = (messages: ModelMessage[]): ModelMessage[] =>
  JSON.parse(JSON.stringify(messages)) as ModelMessage[];

const defaultMemoryKey = (context: AgentMemoryContext) => context.agentId ?? context.runId;
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

const defaultMemoryMessages = (state: AgentRunState): ModelMessage[] => {
  const lastAssistantMessage = [...state.messages].reverse().find((message) => message.role === "assistant");
  return lastAssistantMessage ? [lastAssistantMessage] : [];
};

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

const initializeSqliteTable = (db: SqliteDatabaseLike, sql: string) => {
  db.exec(sql);
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

export const createInMemoryAgentRunStore = (): AgentRunStore => {
  const states = new Map<string, AgentRunState>();

  return {
    load(runId) {
      const state = states.get(runId);
      return state ? cloneState(state) : undefined;
    },
    save(state) {
      states.set(state.runId, cloneState(state));
    },
    delete(runId) {
      states.delete(runId);
    }
  };
};

export const createFileAgentRunStore = (options: {
  directory: string;
}): AgentRunStore => ({
  async load(runId) {
    try {
      const content = await fs.readFile(path.join(options.directory, `${runId}.json`), "utf8");
      return JSON.parse(content) as AgentRunState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  },
  async save(state) {
    await fs.mkdir(options.directory, { recursive: true });
    await fs.writeFile(path.join(options.directory, `${state.runId}.json`), JSON.stringify(state, null, 2), "utf8");
  },
  async delete(runId) {
    try {
      await fs.unlink(path.join(options.directory, `${runId}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
});

export const createInMemoryAgentMemoryStore = (options: {
  key?: (context: AgentMemoryContext) => string;
  initialMessages?: Record<string, ModelMessage[]>;
  selectMessages?: (state: AgentRunState) => ModelMessage[];
} = {}): AgentMemoryStore => {
  const keyFor = options.key ?? defaultMemoryKey;
  const selectMessages = options.selectMessages ?? defaultMemoryMessages;
  const memories = new Map(
    Object.entries(options.initialMessages ?? {}).map(([key, messages]) => [key, cloneMessages(messages)])
  );

  return {
    load(context) {
      return cloneMessages(memories.get(keyFor(context)) ?? []);
    },
    save(context) {
      memories.set(keyFor(context), cloneMessages(selectMessages(context.state)));
    }
  };
};

export const createFileAgentMemoryStore = (options: {
  directory: string;
  key?: (context: AgentMemoryContext) => string;
  selectMessages?: (state: AgentRunState) => ModelMessage[];
}): AgentMemoryStore => {
  const keyFor = options.key ?? defaultMemoryKey;
  const selectMessages = options.selectMessages ?? defaultMemoryMessages;

  return {
    async load(context) {
      try {
        const file = await fs.readFile(path.join(options.directory, `${keyFor(context)}.json`), "utf8");
        return JSON.parse(file) as ModelMessage[];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw error;
      }
    },
    async save(context) {
      await fs.mkdir(options.directory, { recursive: true });
      await fs.writeFile(
        path.join(options.directory, `${keyFor(context)}.json`),
        JSON.stringify(selectMessages(context.state), null, 2),
        "utf8"
      );
    }
  };
};

export const createSqliteAgentRunStore = (options: SqliteAgentRunStoreOptions): AgentRunStore => {
  const tableName = validateIdentifier(options.tableName ?? "zhivex_agent_runs", "tableName");
  initializeSqliteTable(
    options.db,
    `CREATE TABLE IF NOT EXISTS ${tableName} (
      run_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )`
  );

  const loadStatement = prepareSqliteStatement<{ state_json?: string; stateJson?: string }>(
    options.db,
    `SELECT state_json FROM ${tableName} WHERE run_id = ?`
  );
  const saveStatement = prepareSqliteStatement(options.db, `
    INSERT INTO ${tableName} (run_id, state_json, updated_at_ms)
    VALUES (?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      state_json = excluded.state_json,
      updated_at_ms = excluded.updated_at_ms
  `);
  const deleteStatement = prepareSqliteStatement(options.db, `DELETE FROM ${tableName} WHERE run_id = ?`);

  return {
    load(runId) {
      const row = loadStatement.get([runId]);
      const stateJson = getRecordField(row, ["state_json", "stateJson"]);
      return typeof stateJson === "string" ? (JSON.parse(stateJson) as AgentRunState) : undefined;
    },
    save(state) {
      saveStatement.run([state.runId, JSON.stringify(state), Date.now()]);
    },
    delete(runId) {
      deleteStatement.run([runId]);
    }
  };
};

export const createSqliteAgentMemoryStore = (options: SqliteAgentMemoryStoreOptions): AgentMemoryStore => {
  const tableName = validateIdentifier(options.tableName ?? "zhivex_agent_memory", "tableName");
  const keyFor = options.key ?? defaultMemoryKey;
  const selectMessages = options.selectMessages ?? defaultMemoryMessages;

  initializeSqliteTable(
    options.db,
    `CREATE TABLE IF NOT EXISTS ${tableName} (
      memory_key TEXT PRIMARY KEY,
      messages_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )`
  );

  const loadStatement = prepareSqliteStatement<{ messages_json?: string; messagesJson?: string }>(
    options.db,
    `SELECT messages_json FROM ${tableName} WHERE memory_key = ?`
  );
  const saveStatement = prepareSqliteStatement(options.db, `
    INSERT INTO ${tableName} (memory_key, messages_json, updated_at_ms)
    VALUES (?, ?, ?)
    ON CONFLICT(memory_key) DO UPDATE SET
      messages_json = excluded.messages_json,
      updated_at_ms = excluded.updated_at_ms
  `);

  return {
    load(context) {
      const row = loadStatement.get([keyFor(context)]);
      const messagesJson = getRecordField(row, ["messages_json", "messagesJson"]);
      return typeof messagesJson === "string" ? (JSON.parse(messagesJson) as ModelMessage[]) : [];
    },
    save(context) {
      saveStatement.run([keyFor(context), JSON.stringify(selectMessages(context.state)), Date.now()]);
    }
  };
};

export const createPostgresAgentRunStore = (options: PostgresAgentRunStoreOptions): AgentRunStore => {
  const tableName = validateIdentifier(options.tableName ?? "zhivex_agent_runs", "tableName");
  const createSql = `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      run_id TEXT PRIMARY KEY,
      state_json JSONB NOT NULL,
      updated_at_ms BIGINT NOT NULL
    )
  `;

  return {
    async load(runId) {
      await ensurePostgresTable(options.client, tableName, createSql);
      const result = await options.client.query<{ state_json?: AgentRunState; stateJson?: AgentRunState }>(
        `SELECT state_json FROM ${tableName} WHERE run_id = $1`,
        [runId]
      );
      return result.rows[0] ? ((getRecordField(result.rows[0], ["state_json", "stateJson"]) as AgentRunState | undefined) ?? undefined) : undefined;
    },
    async save(state) {
      await ensurePostgresTable(options.client, tableName, createSql);
      await options.client.query(
        `INSERT INTO ${tableName} (run_id, state_json, updated_at_ms)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT(run_id) DO UPDATE SET
           state_json = EXCLUDED.state_json,
           updated_at_ms = EXCLUDED.updated_at_ms`,
        [state.runId, JSON.stringify(state), Date.now()]
      );
    },
    async delete(runId) {
      await ensurePostgresTable(options.client, tableName, createSql);
      await options.client.query(`DELETE FROM ${tableName} WHERE run_id = $1`, [runId]);
    }
  };
};

export const createPostgresAgentMemoryStore = (options: PostgresAgentMemoryStoreOptions): AgentMemoryStore => {
  const tableName = validateIdentifier(options.tableName ?? "zhivex_agent_memory", "tableName");
  const keyFor = options.key ?? defaultMemoryKey;
  const selectMessages = options.selectMessages ?? defaultMemoryMessages;
  const createSql = `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      memory_key TEXT PRIMARY KEY,
      messages_json JSONB NOT NULL,
      updated_at_ms BIGINT NOT NULL
    )
  `;

  return {
    async load(context) {
      await ensurePostgresTable(options.client, tableName, createSql);
      const result = await options.client.query<{ messages_json?: ModelMessage[]; messagesJson?: ModelMessage[] }>(
        `SELECT messages_json FROM ${tableName} WHERE memory_key = $1`,
        [keyFor(context)]
      );
      return result.rows[0]
        ? ((getRecordField(result.rows[0], ["messages_json", "messagesJson"]) as ModelMessage[] | undefined) ?? [])
        : [];
    },
    async save(context) {
      await ensurePostgresTable(options.client, tableName, createSql);
      await options.client.query(
        `INSERT INTO ${tableName} (memory_key, messages_json, updated_at_ms)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT(memory_key) DO UPDATE SET
           messages_json = EXCLUDED.messages_json,
           updated_at_ms = EXCLUDED.updated_at_ms`,
        [keyFor(context), JSON.stringify(selectMessages(context.state)), Date.now()]
      );
    }
  };
};
