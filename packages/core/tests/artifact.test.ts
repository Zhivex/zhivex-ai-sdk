import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createBase64ArtifactData,
  cleanupFileArtifactStore,
  ConflictError,
  createExternalArtifactReference,
  createFileArtifactService,
  createInMemoryArtifactService,
  createPostgresArtifactService,
  createSqliteArtifactService,
  ARTIFACT_SCHEMA_VERSION,
  inspectFileArtifactStore,
  migrateArtifactRecord,
  normalizeArtifactRecord,
  pruneFileArtifactStore,
  verifyArtifactIntegrity,
  verifyArtifactRecordIntegrity,
  ValidationError,
  type ArtifactRecord,
  type PostgresClientLike
} from "../src/index.js";

class FakeSqliteArtifactStatement<TResult extends Record<string, unknown> = Record<string, unknown>> {
  constructor(
    private readonly db: FakeSqliteArtifactDatabase,
    private readonly sql: string
  ) {}

  get(params: unknown[]): TResult | undefined {
    if (this.sql.includes("WHERE artifact_key = ?")) {
      const artifact = this.db.artifacts.get(params[0] as string);
      return artifact ? ({ artifact_json: JSON.stringify(artifact) } as TResult) : undefined;
    }
    return undefined;
  }

  all(params: unknown[]): TResult[] {
    if (!this.sql.includes("SELECT artifact_json")) {
      return [];
    }
    const [
      appName,
      userId,
      sessionId,
      workflowRunId,
      _workflowRunIdAgain,
      workflowStepId,
      _workflowStepIdAgain,
      agentRunId
    ] = params as Array<string | null>;
    return [...this.db.artifacts.values()]
      .filter((artifact) =>
        artifact.appName === appName &&
        artifact.userId === userId &&
        artifact.sessionId === sessionId &&
        (workflowRunId === null || artifact.workflowRunId === workflowRunId) &&
        (workflowStepId === null || artifact.workflowStepId === workflowStepId) &&
        (agentRunId === null || artifact.agentRunId === agentRunId)
      )
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .map((artifact) => ({ artifact_json: JSON.stringify(artifact) } as TResult));
  }

  run(params: unknown[]) {
    if (this.sql.includes("INSERT INTO")) {
      const [
        key,
        appName,
        userId,
        sessionId,
        id,
        workflowRunId,
        workflowStepId,
        agentRunId,
        artifactJson,
        createdAt,
        updatedAt
      ] = params as [string, string, string, string, string, string | null, string | null, string | null, string, number, number];
      const artifact = JSON.parse(artifactJson) as ArtifactRecord;
      this.db.artifacts.set(key, {
        ...artifact,
        appName,
        userId,
        sessionId,
        id,
        workflowRunId: workflowRunId ?? undefined,
        workflowStepId: workflowStepId ?? undefined,
        agentRunId: agentRunId ?? undefined,
        createdAt,
        updatedAt
      });
      return { changes: 1 };
    }
    if (this.sql.includes("UPDATE")) {
      const [
        appName,
        userId,
        sessionId,
        id,
        workflowRunId,
        workflowStepId,
        agentRunId,
        artifactJson,
        updatedAt,
        key,
        expectedUpdatedAt
      ] = params as [string, string, string, string, string | null, string | null, string | null, string, number, string, number];
      const existing = this.db.artifacts.get(key);
      if (this.db.mutateBeforeCas && existing) {
        this.db.artifacts.set(key, { ...existing, updatedAt: existing.updatedAt + 1 });
        this.db.mutateBeforeCas = false;
      }
      const current = this.db.artifacts.get(key);
      if (!current || current.updatedAt !== expectedUpdatedAt) {
        return { changes: 0 };
      }
      const artifact = JSON.parse(artifactJson) as ArtifactRecord;
      this.db.artifacts.set(key, {
        ...artifact,
        appName,
        userId,
        sessionId,
        id,
        workflowRunId: workflowRunId ?? undefined,
        workflowStepId: workflowStepId ?? undefined,
        agentRunId: agentRunId ?? undefined,
        updatedAt
      });
      return { changes: 1 };
    }
    if (this.sql.includes("DELETE FROM")) {
      this.db.artifacts.delete(params[0] as string);
    }
  }
}

class FakeSqliteArtifactDatabase {
  artifacts = new Map<string, ArtifactRecord>();
  execCalls: string[] = [];
  mutateBeforeCas = false;

  exec(sql: string) {
    this.execCalls.push(sql);
  }

  prepare<TResult extends Record<string, unknown>>(sql: string) {
    return new FakeSqliteArtifactStatement<TResult>(this, sql);
  }
}

class FakePostgresArtifactClient {
  artifacts = new Map<string, ArtifactRecord>();
  queries: Array<{ sql: string; params: unknown[] }> = [];
  mutateBeforeCas = false;

  async query<TResult extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<{ rows: TResult[] }> {
    this.queries.push({ sql, params });

    if (sql.includes("SELECT artifact_json") && sql.includes("WHERE artifact_key")) {
      const artifact = this.artifacts.get(params[0] as string);
      return {
        rows: artifact ? ([{ artifact_json: artifact }] as TResult[]) : []
      };
    }

    if (sql.includes("SELECT artifact_json")) {
      const [appName, userId, sessionId, workflowRunId, workflowStepId, agentRunId] = params as Array<string | null>;
      return {
        rows: [...this.artifacts.values()]
          .filter((artifact) =>
            artifact.appName === appName &&
            artifact.userId === userId &&
            artifact.sessionId === sessionId &&
            (workflowRunId === null || artifact.workflowRunId === workflowRunId) &&
            (workflowStepId === null || artifact.workflowStepId === workflowStepId) &&
            (agentRunId === null || artifact.agentRunId === agentRunId)
          )
          .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
          .map((artifact) => ({ artifact_json: artifact } as TResult))
      };
    }

    if (sql.includes("INSERT INTO")) {
      const [
        key,
        appName,
        userId,
        sessionId,
        id,
        workflowRunId,
        workflowStepId,
        agentRunId,
        artifactJson,
        createdAt,
        updatedAt
      ] = params as [string, string, string, string, string, string | null, string | null, string | null, string, number, number];
      const artifact = JSON.parse(artifactJson) as ArtifactRecord;
      this.artifacts.set(key, {
        ...artifact,
        appName,
        userId,
        sessionId,
        id,
        workflowRunId: workflowRunId ?? undefined,
        workflowStepId: workflowStepId ?? undefined,
        agentRunId: agentRunId ?? undefined,
        createdAt,
        updatedAt
      });
    }

    if (sql.includes("UPDATE")) {
      const [
        key,
        appName,
        userId,
        sessionId,
        id,
        workflowRunId,
        workflowStepId,
        agentRunId,
        artifactJson,
        updatedAt,
        expectedUpdatedAt
      ] = params as [string, string, string, string, string, string | null, string | null, string | null, string, number, number];
      const existing = this.artifacts.get(key);
      if (this.mutateBeforeCas && existing) {
        this.artifacts.set(key, { ...existing, updatedAt: existing.updatedAt + 1 });
        this.mutateBeforeCas = false;
      }
      const current = this.artifacts.get(key);
      if (!current || current.updatedAt !== expectedUpdatedAt) {
        return { rows: [] };
      }
      const artifact = JSON.parse(artifactJson) as ArtifactRecord;
      this.artifacts.set(key, {
        ...artifact,
        appName,
        userId,
        sessionId,
        id,
        workflowRunId: workflowRunId ?? undefined,
        workflowStepId: workflowStepId ?? undefined,
        agentRunId: agentRunId ?? undefined,
        updatedAt
      });
      return { rows: [{ artifact_json: artifact }] as TResult[] };
    }

    if (sql.includes("DELETE FROM")) {
      this.artifacts.delete(params[0] as string);
    }

    return { rows: [] };
  }
}

describe("artifact services", () => {
  it("creates base64 artifact data with explicit metadata", () => {
    expect(createBase64ArtifactData("hello")).toEqual({
      data: "aGVsbG8=",
      encoding: "base64",
      size: 5
    });
    expect(createBase64ArtifactData({ data: new Uint8Array([1, 2, 3]) })).toEqual({
      data: "AQID",
      encoding: "base64",
      size: 3
    });
  });

  it("saves and loads artifacts in memory", async () => {
    const service = createInMemoryArtifactService();

    const artifact = await service.saveArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "artifact_1",
      name: "summary.json",
      contentType: "application/json",
      data: { summary: "ok" },
      encoding: "json",
      size: 16,
      sha256: "a".repeat(64),
      metadata: { workflow: "review" }
    });

    expect(artifact).toMatchObject({
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      revision: 1,
      id: "artifact_1",
      name: "summary.json",
      contentType: "application/json",
      data: { summary: "ok" },
      encoding: "json",
      size: 16,
      sha256: "a".repeat(64),
      metadata: { workflow: "review" }
    });
    expect(
      await service.loadArtifact({
        appName: "app",
        userId: "user",
        sessionId: "session",
        id: "artifact_1"
      })
    ).toEqual(artifact);
  });

  it("rejects invalid binary metadata", async () => {
    const service = createInMemoryArtifactService();

    expect(() =>
      service.saveArtifact({
        appName: "app",
        userId: "user",
        sessionId: "session",
        id: "bad-size",
        name: "bad.bin",
        contentType: "application/octet-stream",
        data: "",
        size: -1
      })
    ).toThrow(ValidationError);
    expect(() =>
      service.saveArtifact({
        appName: "app",
        userId: "user",
        sessionId: "session",
        id: "bad-sha",
        name: "bad.bin",
        contentType: "application/octet-stream",
        data: "",
        sha256: "not-a-digest"
      })
    ).toThrow(ValidationError);
  });

  it("saves and loads binary artifacts in memory", async () => {
    const service = createInMemoryArtifactService();
    const artifact = await service.saveBinaryArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "binary",
      name: "binary.bin",
      contentType: "application/octet-stream",
      data: new Uint8Array([1, 2, 3]),
      metadata: { kind: "binary" }
    });

    expect(artifact).toMatchObject({
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      revision: 1,
      id: "binary",
      storageMode: "binary",
      size: 3,
      data: null,
      metadata: { kind: "binary" }
    });
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(service.loadBinaryArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "binary"
    })).toMatchObject({
      artifact,
      data: new Uint8Array([1, 2, 3])
    });
  });

  it("detects optimistic concurrency conflicts for artifacts", async () => {
    const service = createInMemoryArtifactService();
    const artifact = await service.saveArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "conflict",
      name: "conflict.json",
      contentType: "application/json",
      data: { value: 1 }
    });

    const updated = await service.saveArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "conflict",
      name: "conflict.json",
      contentType: "application/json",
      data: { value: 2 },
      expectedRevision: artifact.revision
    });

    expect(updated.revision).toBe(2);
    expect(() =>
      service.saveBinaryArtifact({
        appName: "app",
        userId: "user",
        sessionId: "session",
        id: "conflict",
        name: "conflict.bin",
        contentType: "application/octet-stream",
        data: new Uint8Array([1]),
        expectedRevision: artifact.revision
      })
    ).toThrow(ConflictError);
  });

  it("uses SQL compare-and-swap for artifact expected revisions", async () => {
    const sqliteDb = new FakeSqliteArtifactDatabase();
    const sqlite = createSqliteArtifactService({ db: sqliteDb });
    const sqliteArtifact = await sqlite.saveArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "sqlite-cas",
      name: "sqlite.json",
      contentType: "application/json",
      data: { value: 1 }
    });
    sqliteDb.mutateBeforeCas = true;
    expect(() =>
      sqlite.saveArtifact({
        appName: "app",
        userId: "user",
        sessionId: "session",
        id: "sqlite-cas",
        name: "sqlite.json",
        contentType: "application/json",
        data: { value: 2 },
        expectedRevision: sqliteArtifact.revision
      })
    ).toThrow(ConflictError);

    const postgresClient = new FakePostgresArtifactClient();
    const postgres = createPostgresArtifactService({ client: postgresClient });
    const postgresArtifact = await postgres.saveArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "postgres-cas",
      name: "postgres.json",
      contentType: "application/json",
      data: { value: 1 }
    });
    postgresClient.mutateBeforeCas = true;
    await expect(postgres.saveArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "postgres-cas",
      name: "postgres.json",
      contentType: "application/json",
      data: { value: 2 },
      expectedRevision: postgresArtifact.revision
    })).rejects.toThrow(ConflictError);
  });

  it("lists in-memory artifacts by session and optional workflow filters", async () => {
    const service = createInMemoryArtifactService();

    await service.saveArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "workflow",
      workflowRunId: "wfr_1",
      workflowStepId: "review",
      name: "review.txt",
      contentType: "text/plain",
      data: "review"
    });
    await service.saveArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "agent",
      agentRunId: "run_1",
      name: "agent.txt",
      contentType: "text/plain",
      data: "agent"
    });
    await service.saveArtifact({
      appName: "app",
      userId: "other",
      sessionId: "session",
      id: "other",
      name: "other.txt",
      contentType: "text/plain",
      data: "other"
    });

    expect(
      await service.listArtifacts({
        appName: "app",
        userId: "user",
        sessionId: "session"
      })
    ).toHaveLength(2);
    expect(
      await service.listArtifacts({
        appName: "app",
        userId: "user",
        sessionId: "session",
        workflowRunId: "wfr_1",
        workflowStepId: "review"
      })
    ).toEqual([
      expect.objectContaining({
        id: "workflow",
        workflowRunId: "wfr_1",
        workflowStepId: "review"
      })
    ]);
    expect(
      await service.listArtifacts({
        appName: "app",
        userId: "user",
        sessionId: "session",
        agentRunId: "run_1"
      })
    ).toEqual([
      expect.objectContaining({
        id: "agent",
        agentRunId: "run_1"
      })
    ]);
  });

  it("deletes one in-memory artifact without affecting others", async () => {
    const service = createInMemoryArtifactService();
    await service.saveArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "one",
      name: "one.txt",
      contentType: "text/plain",
      data: "one"
    });
    await service.saveArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "two",
      name: "two.txt",
      contentType: "text/plain",
      data: "two"
    });

    await service.deleteArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "one"
    });

    expect(
      await service.loadArtifact({
        appName: "app",
        userId: "user",
        sessionId: "session",
        id: "one"
      })
    ).toBeUndefined();
    expect(
      await service.listArtifacts({
        appName: "app",
        userId: "user",
        sessionId: "session"
      })
    ).toEqual([expect.objectContaining({ id: "two" })]);
  });

  it("persists file artifacts and reloads them with a new service instance", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "zhivex-artifacts-"));
    const service = createFileArtifactService({ directory });
    const artifact = await service.saveArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "artifact_1",
      workflowRunId: "wfr_1",
      name: "report.md",
      contentType: "text/markdown",
      data: "# Report",
      encoding: "text",
      size: 8,
      sha256: "b".repeat(64)
    });

    const reloaded = createFileArtifactService({ directory });

    await expect(
      reloaded.loadArtifact({
        appName: "app",
        userId: "user",
        sessionId: "session",
        id: "artifact_1"
      })
    ).resolves.toEqual(artifact);
    await expect(
      reloaded.listArtifacts({
        appName: "app",
        userId: "user",
        sessionId: "session",
        workflowRunId: "wfr_1"
      })
    ).resolves.toEqual([artifact]);
  });

  it("normalizes legacy file artifacts and rejects future schema versions", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "zhivex-artifacts-"));
    const service = createFileArtifactService({ directory });
    await service.saveArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "legacy",
      name: "legacy.json",
      contentType: "application/json",
      data: { ok: true }
    });
    const filePath = path.join(directory, (await fs.readdir(directory)).find((entry) => entry.endsWith(".json"))!);
    const legacy = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    delete legacy.schemaVersion;
    await fs.writeFile(filePath, JSON.stringify(legacy), "utf8");

    await expect(service.loadArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "legacy"
    })).resolves.toMatchObject({ schemaVersion: ARTIFACT_SCHEMA_VERSION });

    await fs.writeFile(filePath, JSON.stringify({ ...legacy, schemaVersion: 999 }), "utf8");
    await expect(service.loadArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "legacy"
    })).rejects.toThrow(ValidationError);
  });

  it("stores file binary artifacts as metadata plus separate blobs", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "zhivex-artifacts-"));
    const service = createFileArtifactService({ directory });

    const artifact = await service.saveBinaryArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "binary",
      name: "binary.bin",
      contentType: "application/octet-stream",
      data: new Uint8Array([4, 5, 6])
    });

    const savedBlobPath = artifact.blobPath;
    expect(artifact).toMatchObject({
      storageMode: "binary",
      size: 3,
      data: null
    });
    expect(savedBlobPath).toEqual(expect.stringContaining("blobs"));
    await expect(fs.stat(path.join(directory, savedBlobPath!))).resolves.toMatchObject({ size: 3 });

    const reloaded = createFileArtifactService({ directory });
    await expect(
      reloaded.loadArtifact({
        appName: "app",
        userId: "user",
        sessionId: "session",
        id: "binary"
      })
    ).resolves.toEqual(artifact);
    await expect(
      reloaded.loadBinaryArtifact({
        appName: "app",
        userId: "user",
        sessionId: "session",
        id: "binary"
      })
    ).resolves.toMatchObject({
      artifact,
      data: new Uint8Array([4, 5, 6])
    });

    await reloaded.deleteArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "binary"
    });
    await expect(fs.stat(path.join(directory, artifact.blobPath!))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("verifies artifact integrity for binary and base64 artifacts", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "zhivex-artifacts-"));
    const service = createFileArtifactService({ directory });
    const binary = await service.saveBinaryArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "binary",
      name: "binary.bin",
      contentType: "application/octet-stream",
      data: new Uint8Array([1, 2, 3])
    });

    await expect(verifyArtifactIntegrity(service, {
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "binary"
    })).resolves.toMatchObject({ ok: true, artifact: binary, issues: [] });

    const broken = {
      ...binary,
      sha256: "0".repeat(64)
    };
    expect(verifyArtifactRecordIntegrity(broken, new Uint8Array([1, 2, 3]))).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ type: "sha256-mismatch" })]
    });

    const sqlite = createSqliteArtifactService({ db: new FakeSqliteArtifactDatabase() });
    const base64 = await sqlite.saveBinaryArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "base64",
      name: "base64.bin",
      contentType: "application/octet-stream",
      data: new Uint8Array([4, 5])
    });
    expect(verifyArtifactRecordIntegrity(base64)).toMatchObject({ ok: true });
  });

  it("detects missing blobs and cleans up orphan blobs in file artifact stores", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "zhivex-artifacts-"));
    const service = createFileArtifactService({ directory });
    const artifact = await service.saveBinaryArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "binary",
      name: "binary.bin",
      contentType: "application/octet-stream",
      data: new Uint8Array([1, 2, 3])
    });
    const orphanPath = path.join(directory, "blobs", "orphan.bin");
    await fs.writeFile(orphanPath, new Uint8Array([9]));
    await fs.unlink(path.join(directory, artifact.blobPath!));

    const integrity = await verifyArtifactIntegrity(service, {
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "binary"
    });
    expect(integrity).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ type: "missing-blob" })]
    });

    const inspection = await inspectFileArtifactStore({ directory });
    expect(inspection.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "missing-blob" }),
      expect.objectContaining({ type: "orphan-blob", path: orphanPath })
    ]));

    await cleanupFileArtifactStore({ directory, dryRun: true });
    await expect(fs.stat(orphanPath)).resolves.toBeDefined();
    const cleanup = await cleanupFileArtifactStore({ directory });
    expect(cleanup.deletedBlobPaths).toEqual([orphanPath]);
    await expect(fs.stat(orphanPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses safe file names for artifact identities", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "zhivex-artifacts-"));
    const service = createFileArtifactService({ directory });

    await service.saveArtifact({
      appName: "../app",
      userId: "user/slash",
      sessionId: "session:colon",
      id: "../../artifact",
      name: "unsafe.txt",
      contentType: "text/plain",
      data: "safe"
    });

    const entries = await fs.readdir(directory);

    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toContain("/");
    expect(path.dirname(path.join(directory, entries[0]!))).toBe(directory);
    expect(entries[0]).toBe(
      [
        encodeURIComponent("../app"),
        encodeURIComponent("user/slash"),
        encodeURIComponent("session:colon"),
        encodeURIComponent("../../artifact")
      ].join("__") + ".json"
    );
  });

  it("returns undefined for missing file artifacts", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "zhivex-artifacts-"));
    const service = createFileArtifactService({ directory });

    await expect(
      service.loadArtifact({
        appName: "app",
        userId: "user",
        sessionId: "session",
        id: "missing"
      })
    ).resolves.toBeUndefined();
  });

  it("saves loads lists and deletes SQLite artifacts", async () => {
    const service = createSqliteArtifactService({ db: new FakeSqliteArtifactDatabase() });
    const artifact = await service.saveArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "sqlite",
      workflowRunId: "wfr_1",
      workflowStepId: "step_1",
      name: "sqlite.json",
      contentType: "application/json",
      data: { durable: true },
      encoding: "json",
      size: 18,
      sha256: "c".repeat(64)
    });

    expect(
      await service.loadArtifact({
        appName: "app",
        userId: "user",
        sessionId: "session",
        id: "sqlite"
      })
    ).toEqual(artifact);
    expect(
      await service.listArtifacts({
        appName: "app",
        userId: "user",
        sessionId: "session",
        workflowRunId: "wfr_1",
        workflowStepId: "step_1"
      })
    ).toEqual([artifact]);

    await service.deleteArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "sqlite"
    });

    expect(
      await service.loadArtifact({
        appName: "app",
        userId: "user",
        sessionId: "session",
        id: "sqlite"
      })
    ).toBeUndefined();
  });

  it("stores SQLite binary artifacts as base64 JSON compatibility records", async () => {
    const service = createSqliteArtifactService({ db: new FakeSqliteArtifactDatabase() });

    const artifact = await service.saveBinaryArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "sqlite-binary",
      name: "sqlite.bin",
      contentType: "application/octet-stream",
      data: new Uint8Array([7, 8, 9])
    });

    expect(artifact).toMatchObject({
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      id: "sqlite-binary",
      storageMode: "json",
      encoding: "base64",
      data: "BwgJ",
      size: 3
    });
    expect(service.loadBinaryArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "sqlite-binary"
    })).toMatchObject({
      artifact,
      data: new Uint8Array([7, 8, 9])
    });
  });

  it("filters SQLite artifacts by workflow and agent run", async () => {
    const service = createSqliteArtifactService({ db: new FakeSqliteArtifactDatabase() });
    await service.saveArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "workflow",
      workflowRunId: "wfr_1",
      name: "workflow.txt",
      contentType: "text/plain",
      data: "workflow"
    });
    await service.saveArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "agent",
      agentRunId: "run_1",
      name: "agent.txt",
      contentType: "text/plain",
      data: "agent"
    });

    expect(
      await service.listArtifacts({
        appName: "app",
        userId: "user",
        sessionId: "session",
        agentRunId: "run_1"
      })
    ).toEqual([expect.objectContaining({ id: "agent" })]);
  });

  it("preserves createdAt and updates updatedAt when saving the same artifact id", async () => {
    const service = createSqliteArtifactService({ db: new FakeSqliteArtifactDatabase() });
    const first = await service.saveArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "same",
      name: "same.txt",
      contentType: "text/plain",
      data: "first"
    });

    await new Promise((resolve) => setTimeout(resolve, 2));

    const second = await service.saveArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "same",
      name: "same.txt",
      contentType: "text/plain",
      data: "second"
    });

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    expect(second.data).toBe("second");
  });

  it("saves loads lists and deletes Postgres artifacts", async () => {
    const client = new FakePostgresArtifactClient();
    const service = createPostgresArtifactService({ client });
    const artifact = await service.saveArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "postgres",
      workflowRunId: "wfr_1",
      agentRunId: "run_1",
      name: "postgres.json",
      contentType: "application/json",
      data: { durable: true },
      encoding: "json",
      size: 18,
      sha256: "d".repeat(64)
    });

    await expect(
      service.loadArtifact({
        appName: "app",
        userId: "user",
        sessionId: "session",
        id: "postgres"
      })
    ).resolves.toEqual(artifact);
    await expect(
      service.listArtifacts({
        appName: "app",
        userId: "user",
        sessionId: "session",
        workflowRunId: "wfr_1",
        agentRunId: "run_1"
      })
    ).resolves.toEqual([artifact]);

    await service.deleteArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "postgres"
    });

    await expect(
      service.loadArtifact({
        appName: "app",
        userId: "user",
        sessionId: "session",
        id: "postgres"
      })
    ).resolves.toBeUndefined();
  });

  it("stores Postgres binary artifacts as base64 JSON compatibility records", async () => {
    const service = createPostgresArtifactService({ client: new FakePostgresArtifactClient() });

    const artifact = await service.saveBinaryArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "postgres-binary",
      name: "postgres.bin",
      contentType: "application/octet-stream",
      data: new Uint8Array([10, 11, 12])
    });

    expect(artifact).toMatchObject({
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      id: "postgres-binary",
      storageMode: "json",
      encoding: "base64",
      data: "CgsM",
      size: 3
    });
    await expect(
      service.loadBinaryArtifact({
        appName: "app",
        userId: "user",
        sessionId: "session",
        id: "postgres-binary"
      })
    ).resolves.toMatchObject({
      artifact,
      data: new Uint8Array([10, 11, 12])
    });
  });

  it("creates the Postgres artifacts table lazily once per client and table", async () => {
    const client = new FakePostgresArtifactClient();
    const service = createPostgresArtifactService({ client });

    await service.listArtifacts({ appName: "app", userId: "user", sessionId: "session" });
    await service.listArtifacts({ appName: "app", userId: "user", sessionId: "session" });

    expect(client.queries.filter((query) => query.sql.includes("CREATE TABLE IF NOT EXISTS")).length).toBe(1);
  });

  it("rejects invalid SQL artifact table names", () => {
    expect(() =>
      createSqliteArtifactService({
        db: new FakeSqliteArtifactDatabase(),
        tableName: "bad-name"
      })
    ).toThrow(ValidationError);
    expect(() =>
      createPostgresArtifactService({
        client: new FakePostgresArtifactClient(),
        tableName: "bad-name"
      })
    ).toThrow(ValidationError);
  });

  it("rejects Postgres artifact clients without query()", () => {
    expect(() =>
      createPostgresArtifactService({
        client: {} as PostgresClientLike
      })
    ).toThrow(/app-owned Postgres-compatible client/);
  });

  it("exports artifact APIs from the public index", async () => {
    const api = await import("../src/index.js");

    expect(api.createFileArtifactService).toBeTypeOf("function");
    expect(api.createBase64ArtifactData).toBeTypeOf("function");
    expect(api.normalizeArtifactRecord).toBeTypeOf("function");
    expect(api.createInMemoryArtifactService).toBeTypeOf("function");
    expect(api.createPostgresArtifactService).toBeTypeOf("function");
    expect(api.createSqliteArtifactService).toBeTypeOf("function");
  });

  it("normalizes artifact records directly", () => {
    const normalized = normalizeArtifactRecord({
      id: "artifact",
      appName: "app",
      userId: "user",
      sessionId: "session",
      name: "artifact.json",
      contentType: "application/json",
      data: null,
      createdAt: 1,
      updatedAt: 2
    });

    expect(normalized.schemaVersion).toBe(ARTIFACT_SCHEMA_VERSION);
    expect(normalized.revision).toBe(1);
    expect(() => normalizeArtifactRecord({ ...normalized, schemaVersion: 999 })).toThrow(ValidationError);
    expect(migrateArtifactRecord(normalized)).toMatchObject({ schemaVersion: ARTIFACT_SCHEMA_VERSION });
    expect(() => migrateArtifactRecord(normalized, 999 as 1)).toThrow(ValidationError);
  });

  it("creates external artifact references for app-owned blob storage", () => {
    expect(createExternalArtifactReference({
      uri: "s3://bucket/resume.pdf",
      size: 12,
      metadata: { owner: "app" }
    })).toMatchObject({
      data: null,
      storageMode: "binary",
      size: 12,
      metadata: {
        owner: "app",
        externalBlob: {
          uri: "s3://bucket/resume.pdf",
          managedBy: "application"
        }
      }
    });
    expect(() => createExternalArtifactReference({ uri: "" })).toThrow(ValidationError);
  });

  it("prunes file-backed artifacts by retention policy and deletes blobs", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "zhivex-artifact-prune-"));
    const service = createFileArtifactService({ directory });
    const old = await service.saveBinaryArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "old",
      name: "old.bin",
      contentType: "application/octet-stream",
      data: new Uint8Array([1])
    });
    const recent = await service.saveArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "recent",
      name: "recent.json",
      contentType: "application/json",
      data: { ok: true }
    });
    await fs.writeFile(path.join(directory, "app__user__session__old.json"), JSON.stringify({ ...old, updatedAt: 10 }), "utf8");
    await fs.writeFile(path.join(directory, "app__user__session__recent.json"), JSON.stringify({ ...recent, updatedAt: 100 }), "utf8");

    await expect(pruneFileArtifactStore({ directory, keepLast: 1, dryRun: false })).resolves.toMatchObject({
      deletedArtifactKeys: ["app:user:session:old"],
      keptArtifactKeys: ["app:user:session:recent"],
      deletedBlobPaths: [old.blobPath]
    });
    await expect(service.loadArtifact({ appName: "app", userId: "user", sessionId: "session", id: "old" })).resolves.toBeUndefined();
  });
});
