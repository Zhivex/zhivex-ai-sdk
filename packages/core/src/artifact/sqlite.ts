import { ConflictError, ValidationError } from "../errors.js";
import type { SqliteDatabaseLike, SqliteStatementLike } from "../types.js";
import {
  type SqliteArtifactServiceOptions,
  type ArtifactService,
  resolveArtifactServiceLimits,
  validateIdentifier,
  type ArtifactLookup,
  type ArtifactRecord,
  validateArtifactLookup,
  artifactKey,
  legacyArtifactKey,
  parseArtifactJson,
  getRecordField,
  matchesArtifactLookup,
  lookupFromArtifact,
  cloneArtifact,
  randomId,
  assertExpectedRevision,
  createArtifact,
  bytesFromBinaryInput,
  resolveBinarySha256,
  base64Bytes,
  validateArtifactListInput
} from "./shared.js";

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

export const createSqliteArtifactService = (options: SqliteArtifactServiceOptions): ArtifactService => {
  const limits = resolveArtifactServiceLimits(options.limits);
  const tableName = validateIdentifier(options.tableName ?? "zhivex_artifacts", "tableName");

  options.db.exec(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      artifact_key TEXT PRIMARY KEY,
      app_name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      workflow_run_id TEXT,
      workflow_step_id TEXT,
      agent_run_id TEXT,
      artifact_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )
  `);

  const loadStatement = prepareSqliteStatement<{ artifact_json?: string; artifactJson?: string }>(
    options.db,
    `SELECT artifact_json FROM ${tableName} WHERE artifact_key = ?`
  );
  const listStatement = prepareSqliteStatement<{ artifact_json?: string; artifactJson?: string }>(
    options.db,
    `SELECT artifact_json FROM ${tableName}
     WHERE app_name = ?
       AND user_id = ?
       AND session_id = ?
       AND (? IS NULL OR workflow_run_id = ?)
       AND (? IS NULL OR workflow_step_id = ?)
       AND (? IS NULL OR agent_run_id = ?)
     ORDER BY created_at_ms ASC, artifact_id ASC`
  );
  const saveStatement = prepareSqliteStatement(options.db, `
    INSERT INTO ${tableName} (
      artifact_key,
      app_name,
      user_id,
      session_id,
      artifact_id,
      workflow_run_id,
      workflow_step_id,
      agent_run_id,
      artifact_json,
      created_at_ms,
      updated_at_ms
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(artifact_key) DO UPDATE SET
      app_name = excluded.app_name,
      user_id = excluded.user_id,
      session_id = excluded.session_id,
      artifact_id = excluded.artifact_id,
      workflow_run_id = excluded.workflow_run_id,
      workflow_step_id = excluded.workflow_step_id,
      agent_run_id = excluded.agent_run_id,
      artifact_json = excluded.artifact_json,
      updated_at_ms = excluded.updated_at_ms
  `);
  const insertCasStatement = prepareSqliteStatement(options.db, `
    INSERT INTO ${tableName} (
      artifact_key,
      app_name,
      user_id,
      session_id,
      artifact_id,
      workflow_run_id,
      workflow_step_id,
      agent_run_id,
      artifact_json,
      created_at_ms,
      updated_at_ms
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(artifact_key) DO NOTHING
  `);
  const updateCasStatement = prepareSqliteStatement(options.db, `
    UPDATE ${tableName}
    SET app_name = ?,
        user_id = ?,
        session_id = ?,
        artifact_id = ?,
        workflow_run_id = ?,
        workflow_step_id = ?,
        agent_run_id = ?,
        artifact_json = ?,
        updated_at_ms = ?
    WHERE artifact_key = ?
      AND updated_at_ms = ?
  `);
  const deleteStatement = prepareSqliteStatement(options.db, `DELETE FROM ${tableName} WHERE artifact_key = ?`);

  const load = (input: ArtifactLookup): ArtifactRecord | undefined => {
    validateArtifactLookup(input);
    for (const key of [artifactKey(input), legacyArtifactKey(input)]) {
      const row = loadStatement.get([key]);
      const artifact = parseArtifactJson(getRecordField(row, ["artifact_json", "artifactJson"]), limits);
      if (artifact && matchesArtifactLookup(artifact, input)) {
        return artifact;
      }
    }
    return undefined;
  };

  const save = (
    artifact: ArtifactRecord,
    options?: { existing?: ArtifactRecord; expectedRevision?: number }
  ): ArtifactRecord => {
    if (options?.expectedRevision === 0 && !options.existing) {
      const result = insertCasStatement.run([
        artifactKey(lookupFromArtifact(artifact)),
        artifact.appName,
        artifact.userId,
        artifact.sessionId,
        artifact.id,
        artifact.workflowRunId ?? null,
        artifact.workflowStepId ?? null,
        artifact.agentRunId ?? null,
        JSON.stringify(artifact),
        artifact.createdAt,
        artifact.updatedAt
      ]);
      if (sqliteMutationCount(result) !== 1) {
        throw new ConflictError("ArtifactRecord revision conflict.");
      }
    } else if (options?.expectedRevision !== undefined && options.existing) {
      const canonicalExisting = parseArtifactJson(
        getRecordField(loadStatement.get([artifactKey(artifact)]), ["artifact_json", "artifactJson"]),
        limits
      );
      if (canonicalExisting && matchesArtifactLookup(canonicalExisting, artifact)) {
        const result = updateCasStatement.run([
          artifact.appName,
          artifact.userId,
          artifact.sessionId,
          artifact.id,
          artifact.workflowRunId ?? null,
          artifact.workflowStepId ?? null,
          artifact.agentRunId ?? null,
          JSON.stringify(artifact),
          artifact.updatedAt,
          artifactKey(lookupFromArtifact(artifact)),
          options.existing.updatedAt
        ]);
        if (sqliteMutationCount(result) !== 1) {
          throw new ConflictError("ArtifactRecord revision conflict.");
        }
      } else {
        const legacy = parseArtifactJson(
          getRecordField(loadStatement.get([legacyArtifactKey(artifact)]), ["artifact_json", "artifactJson"]),
          limits
        );
        if (!legacy || !matchesArtifactLookup(legacy, artifact) || legacy.updatedAt !== options.existing.updatedAt) {
          throw new ConflictError("ArtifactRecord revision conflict.");
        }
        saveStatement.run([
          artifactKey(artifact),
          artifact.appName,
          artifact.userId,
          artifact.sessionId,
          artifact.id,
          artifact.workflowRunId ?? null,
          artifact.workflowStepId ?? null,
          artifact.agentRunId ?? null,
          JSON.stringify(artifact),
          artifact.createdAt,
          artifact.updatedAt
        ]);
      }
    } else {
      saveStatement.run([
        artifactKey(lookupFromArtifact(artifact)),
        artifact.appName,
        artifact.userId,
        artifact.sessionId,
        artifact.id,
        artifact.workflowRunId ?? null,
        artifact.workflowStepId ?? null,
        artifact.agentRunId ?? null,
        JSON.stringify(artifact),
        artifact.createdAt,
        artifact.updatedAt
      ]);
    }
    const legacy = parseArtifactJson(
      getRecordField(loadStatement.get([legacyArtifactKey(artifact)]), ["artifact_json", "artifactJson"]),
      limits
    );
    if (legacy && matchesArtifactLookup(legacy, artifact)) {
      deleteStatement.run([legacyArtifactKey(artifact)]);
    }
    return cloneArtifact(artifact);
  };

  return {
    saveArtifact(input) {
      const id = input.id ?? randomId("art");
      validateArtifactLookup({ appName: input.appName, userId: input.userId, sessionId: input.sessionId, id });
      const existing = load({
        appName: input.appName,
        userId: input.userId,
        sessionId: input.sessionId,
        id
      });
      assertExpectedRevision(existing, input.expectedRevision, "ArtifactRecord");
      return save(createArtifact({ ...input, id }, limits, existing), {
        existing,
        expectedRevision: input.expectedRevision
      });
    },

    saveBinaryArtifact(input) {
      const id = input.id ?? randomId("art");
      validateArtifactLookup({ appName: input.appName, userId: input.userId, sessionId: input.sessionId, id });
      const bytes = bytesFromBinaryInput(input.data, limits.maxBinaryBytes);
      const sha256 = resolveBinarySha256(bytes, input.sha256);
      const existing = load({
        appName: input.appName,
        userId: input.userId,
        sessionId: input.sessionId,
        id
      });
      assertExpectedRevision(existing, input.expectedRevision, "ArtifactRecord");
      return save(createArtifact({
        ...input,
        id,
        data: Buffer.from(bytes).toString("base64"),
        encoding: "base64",
        size: bytes.byteLength,
        sha256,
        storageMode: "json"
      }, limits, existing), {
        existing,
        expectedRevision: input.expectedRevision
      });
    },

    loadArtifact(input) {
      return load(input);
    },

    loadBinaryArtifact(input) {
      const artifact = load(input);
      if (!artifact || artifact.encoding !== "base64" || typeof artifact.data !== "string") {
        return undefined;
      }
      return {
        artifact,
        data: base64Bytes(artifact.data, limits.maxBase64Bytes)
      };
    },

    listArtifacts(input) {
      validateArtifactListInput(input);
      const params = [
        input.appName,
        input.userId,
        input.sessionId,
        input.workflowRunId ?? null,
        input.workflowRunId ?? null,
        input.workflowStepId ?? null,
        input.workflowStepId ?? null,
        input.agentRunId ?? null,
        input.agentRunId ?? null
      ];
      const rows = listStatement.all?.(params) ?? [];
      const artifacts = new Map<string, ArtifactRecord>();
      for (const row of rows) {
        const artifact = parseArtifactJson(getRecordField(row, ["artifact_json", "artifactJson"]), limits);
        if (artifact) {
          artifacts.set(artifactKey(artifact), artifact);
        }
      }
      return [...artifacts.values()];
    },

    deleteArtifact(input) {
      validateArtifactLookup(input);
      deleteStatement.run([artifactKey(input)]);
      const legacy = parseArtifactJson(
        getRecordField(loadStatement.get([legacyArtifactKey(input)]), ["artifact_json", "artifactJson"]),
        limits
      );
      if (legacy && matchesArtifactLookup(legacy, input)) {
        deleteStatement.run([legacyArtifactKey(input)]);
      }
    }
  };
};
