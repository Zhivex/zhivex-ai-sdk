import { ConflictError } from "../errors.js";
import { assertPostgresClient } from "../postgres-client.js";
import type { PostgresClientLike } from "../types.js";
import {
  type PostgresArtifactServiceOptions,
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

export const createPostgresArtifactService = (options: PostgresArtifactServiceOptions): ArtifactService => {
  assertPostgresClient(options.client);
  const limits = resolveArtifactServiceLimits(options.limits);
  const tableName = validateIdentifier(options.tableName ?? "zhivex_artifacts", "tableName");
  const createSql = `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      artifact_key TEXT PRIMARY KEY,
      app_name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      workflow_run_id TEXT,
      workflow_step_id TEXT,
      agent_run_id TEXT,
      artifact_json JSONB NOT NULL,
      created_at_ms BIGINT NOT NULL,
      updated_at_ms BIGINT NOT NULL
    )
  `;

  const load = async (input: ArtifactLookup): Promise<ArtifactRecord | undefined> => {
    validateArtifactLookup(input);
    await ensurePostgresTable(options.client, tableName, createSql);
    for (const key of [artifactKey(input), legacyArtifactKey(input)]) {
      const result = await options.client.query<{ artifact_json?: ArtifactRecord; artifactJson?: ArtifactRecord }>(
        `SELECT artifact_json FROM ${tableName} WHERE artifact_key = $1`,
        [key]
      );
      const artifact = parseArtifactJson(getRecordField(result.rows[0], ["artifact_json", "artifactJson"]), limits);
      if (artifact && matchesArtifactLookup(artifact, input)) {
        return artifact;
      }
    }
    return undefined;
  };

  const save = async (
    artifact: ArtifactRecord,
    saveOptions?: { existing?: ArtifactRecord; expectedRevision?: number }
  ): Promise<ArtifactRecord> => {
    await ensurePostgresTable(options.client, tableName, createSql);
    if (saveOptions?.expectedRevision === 0 && !saveOptions.existing) {
      const result = await options.client.query(
        `INSERT INTO ${tableName} (
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
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
         ON CONFLICT(artifact_key) DO NOTHING
         RETURNING artifact_json`,
        [
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
        ]
      );
      if (result.rows.length === 0) {
        throw new ConflictError("ArtifactRecord revision conflict.");
      }
    } else if (saveOptions?.expectedRevision !== undefined && saveOptions.existing) {
      const result = await options.client.query(
        `UPDATE ${tableName}
         SET app_name = $2,
             user_id = $3,
             session_id = $4,
             artifact_id = $5,
             workflow_run_id = $6,
             workflow_step_id = $7,
             agent_run_id = $8,
             artifact_json = $9::jsonb,
             updated_at_ms = $10
         WHERE artifact_key = $1
           AND updated_at_ms = $11
         RETURNING artifact_json`,
        [
          artifactKey(lookupFromArtifact(artifact)),
          artifact.appName,
          artifact.userId,
          artifact.sessionId,
          artifact.id,
          artifact.workflowRunId ?? null,
          artifact.workflowStepId ?? null,
          artifact.agentRunId ?? null,
          JSON.stringify(artifact),
          artifact.updatedAt,
          saveOptions.existing.updatedAt
        ]
      );
      if (result.rows.length === 0) {
        const migrated = await options.client.query(
          `UPDATE ${tableName}
           SET artifact_key = $1,
               app_name = $2,
               user_id = $3,
               session_id = $4,
               artifact_id = $5,
               workflow_run_id = $6,
               workflow_step_id = $7,
               agent_run_id = $8,
               artifact_json = $9::jsonb,
               updated_at_ms = $10
           WHERE artifact_key = $11
             AND updated_at_ms = $12
           RETURNING artifact_json`,
          [
            artifactKey(artifact),
            artifact.appName,
            artifact.userId,
            artifact.sessionId,
            artifact.id,
            artifact.workflowRunId ?? null,
            artifact.workflowStepId ?? null,
            artifact.agentRunId ?? null,
            JSON.stringify(artifact),
            artifact.updatedAt,
            legacyArtifactKey(artifact),
            saveOptions.existing.updatedAt
          ]
        );
        if (migrated.rows.length === 0) {
          throw new ConflictError("ArtifactRecord revision conflict.");
        }
      }
    } else {
      await options.client.query(
        `INSERT INTO ${tableName} (
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
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
         ON CONFLICT(artifact_key) DO UPDATE SET
           app_name = EXCLUDED.app_name,
           user_id = EXCLUDED.user_id,
           session_id = EXCLUDED.session_id,
           artifact_id = EXCLUDED.artifact_id,
           workflow_run_id = EXCLUDED.workflow_run_id,
           workflow_step_id = EXCLUDED.workflow_step_id,
           agent_run_id = EXCLUDED.agent_run_id,
           artifact_json = EXCLUDED.artifact_json,
           updated_at_ms = EXCLUDED.updated_at_ms`,
        [
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
        ]
      );
    }
    const legacyResult = await options.client.query<{ artifact_json?: ArtifactRecord; artifactJson?: ArtifactRecord }>(
      `SELECT artifact_json FROM ${tableName} WHERE artifact_key = $1`,
      [legacyArtifactKey(artifact)]
    );
    const legacy = parseArtifactJson(
      getRecordField(legacyResult.rows[0], ["artifact_json", "artifactJson"]),
      limits
    );
    if (legacy && matchesArtifactLookup(legacy, artifact)) {
      await options.client.query(`DELETE FROM ${tableName} WHERE artifact_key = $1`, [legacyArtifactKey(artifact)]);
    }
    return cloneArtifact(artifact);
  };

  return {
    async saveArtifact(input) {
      const id = input.id ?? randomId("art");
      validateArtifactLookup({ appName: input.appName, userId: input.userId, sessionId: input.sessionId, id });
      const existing = await load({
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

    async saveBinaryArtifact(input) {
      const id = input.id ?? randomId("art");
      validateArtifactLookup({ appName: input.appName, userId: input.userId, sessionId: input.sessionId, id });
      const bytes = bytesFromBinaryInput(input.data, limits.maxBinaryBytes);
      const sha256 = resolveBinarySha256(bytes, input.sha256);
      const existing = await load({
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

    async loadBinaryArtifact(input) {
      const artifact = await load(input);
      if (!artifact || artifact.encoding !== "base64" || typeof artifact.data !== "string") {
        return undefined;
      }
      return {
        artifact,
        data: base64Bytes(artifact.data, limits.maxBase64Bytes)
      };
    },

    async listArtifacts(input) {
      validateArtifactListInput(input);
      await ensurePostgresTable(options.client, tableName, createSql);
      const result = await options.client.query<{ artifact_json?: ArtifactRecord; artifactJson?: ArtifactRecord }>(
        `SELECT artifact_json FROM ${tableName}
         WHERE app_name = $1
           AND user_id = $2
           AND session_id = $3
           AND ($4::text IS NULL OR workflow_run_id = $4)
           AND ($5::text IS NULL OR workflow_step_id = $5)
           AND ($6::text IS NULL OR agent_run_id = $6)
         ORDER BY created_at_ms ASC, artifact_id ASC`,
        [
          input.appName,
          input.userId,
          input.sessionId,
          input.workflowRunId ?? null,
          input.workflowStepId ?? null,
          input.agentRunId ?? null
        ]
      );
      const artifacts = new Map<string, ArtifactRecord>();
      for (const row of result.rows) {
        const artifact = parseArtifactJson(getRecordField(row, ["artifact_json", "artifactJson"]), limits);
        if (artifact) {
          artifacts.set(artifactKey(artifact), artifact);
        }
      }
      return [...artifacts.values()];
    },

    async deleteArtifact(input) {
      validateArtifactLookup(input);
      await ensurePostgresTable(options.client, tableName, createSql);
      await options.client.query(`DELETE FROM ${tableName} WHERE artifact_key = $1`, [artifactKey(input)]);
      const legacyResult = await options.client.query<{ artifact_json?: ArtifactRecord; artifactJson?: ArtifactRecord }>(
        `SELECT artifact_json FROM ${tableName} WHERE artifact_key = $1`,
        [legacyArtifactKey(input)]
      );
      const legacy = parseArtifactJson(
        getRecordField(legacyResult.rows[0], ["artifact_json", "artifactJson"]),
        limits
      );
      if (legacy && matchesArtifactLookup(legacy, input)) {
        await options.client.query(`DELETE FROM ${tableName} WHERE artifact_key = $1`, [legacyArtifactKey(input)]);
      }
    }
  };
};
