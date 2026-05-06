import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import { ConflictError, ValidationError } from "./errors.js";
import { assertPostgresClient } from "./postgres-client.js";
import type { JsonValue, PostgresClientLike, SqliteDatabaseLike, SqliteStatementLike } from "./types.js";

const randomId = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const ARTIFACT_SCHEMA_VERSION = 1 as const;

export interface ArtifactLookup {
  appName: string;
  userId: string;
  sessionId: string;
  id: string;
}

export interface ArtifactListInput {
  appName: string;
  userId: string;
  sessionId: string;
  workflowRunId?: string;
  workflowStepId?: string;
  agentRunId?: string;
}

export interface ArtifactSaveInput {
  appName: string;
  userId: string;
  sessionId: string;
  id?: string;
  workflowRunId?: string;
  workflowStepId?: string;
  agentRunId?: string;
  name: string;
  contentType: string;
  data: JsonValue | string;
  encoding?: ArtifactEncoding;
  size?: number;
  sha256?: string;
  storageMode?: ArtifactStorageMode;
  blobPath?: string;
  expectedRevision?: number;
  metadata?: Record<string, JsonValue>;
}

export type ArtifactEncoding = "json" | "text" | "base64";
export type ArtifactStorageMode = "json" | "binary";

export interface ArtifactRecord {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSION;
  revision: number;
  id: string;
  appName: string;
  userId: string;
  sessionId: string;
  workflowRunId?: string;
  workflowStepId?: string;
  agentRunId?: string;
  name: string;
  contentType: string;
  data: JsonValue | string;
  encoding?: ArtifactEncoding;
  size?: number;
  sha256?: string;
  storageMode?: ArtifactStorageMode;
  blobPath?: string;
  metadata?: Record<string, JsonValue>;
  createdAt: number;
  updatedAt: number;
}

export interface ArtifactBinarySaveInput extends Omit<ArtifactSaveInput, "data" | "encoding" | "size" | "sha256"> {
  data: string | ArrayBuffer | Uint8Array;
  sha256?: string;
  metadata?: Record<string, JsonValue>;
}

export interface ArtifactBinaryLoadOutput {
  artifact: ArtifactRecord;
  data: Uint8Array;
}

export interface Base64ArtifactDataInput {
  data: string | ArrayBuffer | Uint8Array;
}

export interface Base64ArtifactData {
  data: string;
  encoding: "base64";
  size: number;
}

export interface ArtifactService {
  saveArtifact(input: ArtifactSaveInput): Promise<ArtifactRecord> | ArtifactRecord;
  saveBinaryArtifact(input: ArtifactBinarySaveInput): Promise<ArtifactRecord> | ArtifactRecord;
  loadArtifact(input: ArtifactLookup): Promise<ArtifactRecord | undefined> | ArtifactRecord | undefined;
  loadBinaryArtifact(input: ArtifactLookup): Promise<ArtifactBinaryLoadOutput | undefined> | ArtifactBinaryLoadOutput | undefined;
  listArtifacts(input: ArtifactListInput): Promise<ArtifactRecord[]> | ArtifactRecord[];
  deleteArtifact(input: ArtifactLookup): Promise<void> | void;
}

export interface FileArtifactServiceOptions {
  directory: string;
}

export interface SqliteArtifactServiceOptions {
  db: SqliteDatabaseLike;
  tableName?: string;
}

export interface PostgresArtifactServiceOptions {
  client: PostgresClientLike;
  tableName?: string;
}

export interface ArtifactIntegrityIssue {
  type: "missing-artifact" | "missing-blob" | "size-mismatch" | "sha256-mismatch" | "invalid-base64" | "metadata-invalid";
  message: string;
  expected?: JsonValue;
  actual?: JsonValue;
}

export interface ArtifactIntegrityResult {
  ok: boolean;
  artifact?: ArtifactRecord;
  issues: ArtifactIntegrityIssue[];
}

export interface FileArtifactStoreInspectionIssue {
  type: "orphan-blob" | "missing-blob" | "invalid-metadata";
  path: string;
  artifact?: ArtifactRecord;
  message: string;
}

export interface FileArtifactStoreInspection {
  directory: string;
  artifacts: ArtifactRecord[];
  issues: FileArtifactStoreInspectionIssue[];
}

export interface FileArtifactStoreCleanupOptions extends FileArtifactServiceOptions {
  dryRun?: boolean;
}

export interface FileArtifactStoreCleanupResult extends FileArtifactStoreInspection {
  dryRun: boolean;
  deletedBlobPaths: string[];
}

export interface FileArtifactStorePruneOptions extends FileArtifactServiceOptions {
  olderThanMs?: number;
  keepLast?: number;
  now?: number;
  dryRun?: boolean;
}

export interface FileArtifactStorePruneResult {
  directory: string;
  dryRun: boolean;
  deletedArtifactKeys: string[];
  keptArtifactKeys: string[];
  deletedBlobPaths: string[];
}

export interface ExternalArtifactReferenceInput {
  uri: string;
  size?: number;
  sha256?: string;
  metadata?: Record<string, JsonValue>;
}

export interface ExternalArtifactReference {
  data: null;
  storageMode: "binary";
  metadata: Record<string, JsonValue>;
  size?: number;
  sha256?: string;
}

export type ArtifactRecordMigrationTarget = typeof ARTIFACT_SCHEMA_VERSION;

const artifactKey = (input: ArtifactLookup): string =>
  `${input.appName}:${input.userId}:${input.sessionId}:${input.id}`;
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const normalizeArtifactRecord = (value: unknown): ArtifactRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("ArtifactRecord must be an object.");
  }
  const artifact = value as Partial<ArtifactRecord> & { schemaVersion?: number };
  if (artifact.schemaVersion !== undefined && artifact.schemaVersion > ARTIFACT_SCHEMA_VERSION) {
    throw new ValidationError(`Unsupported ArtifactRecord schemaVersion ${artifact.schemaVersion}.`);
  }
  if (
    typeof artifact.id !== "string" ||
    typeof artifact.appName !== "string" ||
    typeof artifact.userId !== "string" ||
    typeof artifact.sessionId !== "string" ||
    typeof artifact.name !== "string" ||
    typeof artifact.contentType !== "string" ||
    typeof artifact.createdAt !== "number" ||
    typeof artifact.updatedAt !== "number" ||
    !("data" in artifact)
  ) {
    throw new ValidationError("ArtifactRecord is missing required fields.");
  }
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    revision: typeof artifact.revision === "number" ? artifact.revision : 1,
    id: artifact.id,
    appName: artifact.appName,
    userId: artifact.userId,
    sessionId: artifact.sessionId,
    workflowRunId: artifact.workflowRunId,
    workflowStepId: artifact.workflowStepId,
    agentRunId: artifact.agentRunId,
    name: artifact.name,
    contentType: artifact.contentType,
    data: cloneJson(artifact.data as JsonValue | string),
    encoding: artifact.encoding,
    size: artifact.size,
    sha256: artifact.sha256,
    storageMode: artifact.storageMode ?? "json",
    blobPath: artifact.blobPath,
    metadata: artifact.metadata ? cloneJson(artifact.metadata) : undefined,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt
  };
};

export const migrateArtifactRecord = (
  value: unknown,
  targetVersion: ArtifactRecordMigrationTarget = ARTIFACT_SCHEMA_VERSION
): ArtifactRecord => {
  if (targetVersion !== ARTIFACT_SCHEMA_VERSION) {
    throw new ValidationError(`Unsupported ArtifactRecord migration target ${targetVersion}.`);
  }
  return normalizeArtifactRecord(value);
};

const cloneArtifact = (artifact: ArtifactRecord): ArtifactRecord => cloneJson(normalizeArtifactRecord(artifact));

const bytesFromBinaryInput = (data: string | ArrayBuffer | Uint8Array): Uint8Array => {
  const buffer =
    typeof data === "string"
      ? Buffer.from(data, "utf8")
      : data instanceof Uint8Array
        ? Buffer.from(data)
        : Buffer.from(data);
  return new Uint8Array(buffer);
};

const sha256Digest = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

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

const validateArtifactMetadata = (input: Pick<ArtifactSaveInput, "size" | "sha256">) => {
  if (input.size !== undefined && (!Number.isInteger(input.size) || input.size < 0)) {
    throw new ValidationError('The "size" artifact option must be a non-negative integer.');
  }
  if (input.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(input.sha256)) {
    throw new ValidationError('The "sha256" artifact option must be a 64-character hexadecimal digest.');
  }
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

const parseArtifactJson = (value: unknown): ArtifactRecord | undefined => {
  if (!value) {
    return undefined;
  }

  if (typeof value === "string") {
    return normalizeArtifactRecord(JSON.parse(value) as ArtifactRecord);
  }

  return normalizeArtifactRecord(value);
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

const createArtifact = (input: ArtifactSaveInput, existing?: ArtifactRecord): ArtifactRecord => {
  validateArtifactMetadata(input);
  const now = Date.now();
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    revision: existing ? existing.revision + 1 : 1,
    id: input.id ?? existing?.id ?? randomId("art"),
    appName: input.appName,
    userId: input.userId,
    sessionId: input.sessionId,
    workflowRunId: input.workflowRunId,
    workflowStepId: input.workflowStepId,
    agentRunId: input.agentRunId,
    name: input.name,
    contentType: input.contentType,
    data: cloneJson(input.data),
    encoding: input.encoding,
    size: input.size,
    sha256: input.sha256,
    storageMode: input.storageMode ?? "json",
    blobPath: input.blobPath,
    metadata: input.metadata ? cloneJson(input.metadata) : undefined,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
};

const matchesListInput = (artifact: ArtifactRecord, input: ArtifactListInput): boolean =>
  artifact.appName === input.appName &&
  artifact.userId === input.userId &&
  artifact.sessionId === input.sessionId &&
  (input.workflowRunId === undefined || artifact.workflowRunId === input.workflowRunId) &&
  (input.workflowStepId === undefined || artifact.workflowStepId === input.workflowStepId) &&
  (input.agentRunId === undefined || artifact.agentRunId === input.agentRunId);

const fileNameForArtifact = (input: ArtifactLookup): string =>
  [input.appName, input.userId, input.sessionId, input.id].map((part) => encodeURIComponent(part)).join("__") + ".json";

const blobPathForArtifact = (input: ArtifactLookup): string =>
  path.join("blobs", [input.appName, input.userId, input.sessionId, input.id].map((part) => encodeURIComponent(part)).join("__") + ".bin");

const lookupFromArtifact = (artifact: ArtifactRecord): ArtifactLookup => ({
  appName: artifact.appName,
  userId: artifact.userId,
  sessionId: artifact.sessionId,
  id: artifact.id
});

export const createBase64ArtifactData = (
  input: Base64ArtifactDataInput | string | ArrayBuffer | Uint8Array
): Base64ArtifactData => {
  const data = typeof input === "object" && "data" in input ? input.data : input;
  const buffer =
    typeof data === "string"
      ? Buffer.from(data, "utf8")
      : data instanceof Uint8Array
        ? Buffer.from(data)
        : Buffer.from(data);
  return {
    data: buffer.toString("base64"),
    encoding: "base64",
    size: buffer.byteLength
  };
};

export const createExternalArtifactReference = (
  input: ExternalArtifactReferenceInput
): ExternalArtifactReference => {
  validateArtifactMetadata(input);
  if (!input.uri) {
    throw new ValidationError('The "uri" external artifact reference option is required.');
  }
  return {
    data: null,
    storageMode: "binary",
    size: input.size,
    sha256: input.sha256,
    metadata: {
      ...(input.metadata ?? {}),
      externalBlob: {
        uri: input.uri,
        managedBy: "application"
      }
    }
  };
};

export const verifyArtifactRecordIntegrity = (
  record: ArtifactRecord,
  data?: Uint8Array
): ArtifactIntegrityResult => {
  const artifact = normalizeArtifactRecord(record);
  const issues: ArtifactIntegrityIssue[] = [];
  let bytes = data;

  if (!bytes && artifact.encoding === "base64" && typeof artifact.data === "string") {
    try {
      bytes = new Uint8Array(Buffer.from(artifact.data, "base64"));
    } catch {
      issues.push({
        type: "invalid-base64",
        message: `Artifact "${artifact.id}" contains invalid base64 data.`
      });
    }
  }

  if (bytes) {
    if (artifact.size !== undefined && artifact.size !== bytes.byteLength) {
      issues.push({
        type: "size-mismatch",
        message: `Artifact "${artifact.id}" size does not match.`,
        expected: artifact.size,
        actual: bytes.byteLength
      });
    }
    if (artifact.sha256 !== undefined) {
      const actual = sha256Digest(bytes);
      if (artifact.sha256 !== actual) {
        issues.push({
          type: "sha256-mismatch",
          message: `Artifact "${artifact.id}" sha256 does not match.`,
          expected: artifact.sha256,
          actual
        });
      }
    }
  }

  return {
    ok: issues.length === 0,
    artifact,
    issues
  };
};

export const verifyArtifactIntegrity = async (
  service: ArtifactService,
  lookup: ArtifactLookup
): Promise<ArtifactIntegrityResult> => {
  const artifact = await service.loadArtifact(lookup);
  if (!artifact) {
    return {
      ok: false,
      issues: [{
        type: "missing-artifact",
        message: `Artifact "${lookup.id}" was not found.`
      }]
    };
  }

  if (artifact.storageMode === "binary") {
    const binary = await service.loadBinaryArtifact(lookup);
    if (!binary) {
      return {
        ok: false,
        artifact,
        issues: [{
          type: "missing-blob",
          message: `Artifact "${lookup.id}" binary blob was not found.`
        }]
      };
    }
    return verifyArtifactRecordIntegrity(binary.artifact, binary.data);
  }

  return verifyArtifactRecordIntegrity(artifact);
};

const listFilesRecursive = async (directory: string): Promise<string[]> => {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return listFilesRecursive(fullPath);
      }
      return [fullPath];
    }));
    return files.flat();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
};

export const inspectFileArtifactStore = async (
  options: FileArtifactServiceOptions
): Promise<FileArtifactStoreInspection> => {
  const artifacts: ArtifactRecord[] = [];
  const issues: FileArtifactStoreInspectionIssue[] = [];
  const referencedBlobPaths = new Set<string>();
  let entries: string[] = [];
  try {
    entries = await fs.readdir(options.directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const metadataPath = path.join(options.directory, entry);
    try {
      const artifact = normalizeArtifactRecord(JSON.parse(await fs.readFile(metadataPath, "utf8")) as ArtifactRecord);
      artifacts.push(artifact);
      if (artifact.blobPath) {
        referencedBlobPaths.add(path.normalize(artifact.blobPath));
      }
      if (artifact.storageMode === "binary") {
        if (!artifact.blobPath) {
          issues.push({
            type: "missing-blob",
            path: metadataPath,
            artifact,
            message: `Artifact "${artifact.id}" has no blobPath.`
          });
        } else {
          const fullBlobPath = path.join(options.directory, artifact.blobPath);
          try {
            await fs.stat(fullBlobPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              issues.push({
                type: "missing-blob",
                path: fullBlobPath,
                artifact,
                message: `Artifact "${artifact.id}" references a missing blob.`
              });
            } else {
              throw error;
            }
          }
        }
      }
    } catch (error) {
      issues.push({
        type: "invalid-metadata",
        path: metadataPath,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const blobRoot = path.join(options.directory, "blobs");
  for (const blobFile of await listFilesRecursive(blobRoot)) {
    const relative = path.normalize(path.relative(options.directory, blobFile));
    if (!referencedBlobPaths.has(relative)) {
      issues.push({
        type: "orphan-blob",
        path: blobFile,
        message: `Blob "${relative}" is not referenced by artifact metadata.`
      });
    }
  }

  return {
    directory: options.directory,
    artifacts: artifacts.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)),
    issues
  };
};

export const cleanupFileArtifactStore = async (
  options: FileArtifactStoreCleanupOptions
): Promise<FileArtifactStoreCleanupResult> => {
  const inspection = await inspectFileArtifactStore(options);
  const deletedBlobPaths: string[] = [];
  for (const issue of inspection.issues) {
    if (issue.type !== "orphan-blob") {
      continue;
    }
    if (!options.dryRun) {
      await fs.unlink(issue.path);
    }
    deletedBlobPaths.push(issue.path);
  }

  return {
    ...inspection,
    dryRun: Boolean(options.dryRun),
    deletedBlobPaths
  };
};

export const pruneFileArtifactStore = async (
  options: FileArtifactStorePruneOptions
): Promise<FileArtifactStorePruneResult> => {
  const now = options.now ?? Date.now();
  const dryRun = options.dryRun ?? true;
  const inspection = await inspectFileArtifactStore({ directory: options.directory });
  const sorted = inspection.artifacts.sort((left, right) =>
    right.updatedAt - left.updatedAt || artifactKey(left).localeCompare(artifactKey(right))
  );
  const keepByCount = new Set(
    options.keepLast === undefined ? [] : sorted.slice(0, Math.max(0, options.keepLast)).map((artifact) => artifactKey(artifact))
  );
  const shouldDelete = (artifact: ArtifactRecord) =>
    !keepByCount.has(artifactKey(artifact)) &&
    (options.olderThanMs !== undefined ? now - artifact.updatedAt > options.olderThanMs : options.keepLast !== undefined);
  const deleted = sorted.filter(shouldDelete);
  const deletedBlobPaths = deleted.flatMap((artifact) => artifact.blobPath ? [artifact.blobPath] : []);

  if (!dryRun) {
    for (const artifact of deleted) {
      await fs.unlink(path.join(options.directory, fileNameForArtifact(artifact))).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
      if (artifact.blobPath) {
        await fs.unlink(path.join(options.directory, artifact.blobPath)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") {
            throw error;
          }
        });
      }
    }
  }

  return {
    directory: options.directory,
    dryRun,
    deletedArtifactKeys: deleted.map((artifact) => artifactKey(artifact)),
    keptArtifactKeys: sorted.filter((artifact) => !shouldDelete(artifact)).map((artifact) => artifactKey(artifact)),
    deletedBlobPaths
  };
};

export const createInMemoryArtifactService = (): ArtifactService => {
  const artifacts = new Map<string, ArtifactRecord>();
  const binaryData = new Map<string, Uint8Array>();

  return {
    saveArtifact(input) {
      const id = input.id ?? randomId("art");
      const lookup = {
        appName: input.appName,
        userId: input.userId,
        sessionId: input.sessionId,
        id
      };
      const existing = artifacts.get(artifactKey(lookup));
      assertExpectedRevision(existing, input.expectedRevision, "ArtifactRecord");
      const artifact = createArtifact({ ...input, id }, existing);
      artifacts.set(artifactKey(lookup), cloneArtifact(artifact));
      binaryData.delete(artifactKey(lookup));
      return cloneArtifact(artifact);
    },

    saveBinaryArtifact(input) {
      const id = input.id ?? randomId("art");
      const lookup = {
        appName: input.appName,
        userId: input.userId,
        sessionId: input.sessionId,
        id
      };
      const bytes = bytesFromBinaryInput(input.data);
      const sha256 = input.sha256 ?? sha256Digest(bytes);
      const existing = artifacts.get(artifactKey(lookup));
      assertExpectedRevision(existing, input.expectedRevision, "ArtifactRecord");
      const artifact = createArtifact({
        ...input,
        id,
        data: null,
        encoding: "base64",
        size: bytes.byteLength,
        sha256,
        storageMode: "binary"
      }, existing);
      artifacts.set(artifactKey(lookup), cloneArtifact(artifact));
      binaryData.set(artifactKey(lookup), new Uint8Array(bytes));
      return cloneArtifact(artifact);
    },

    loadArtifact(input) {
      const artifact = artifacts.get(artifactKey(input));
      return artifact ? cloneArtifact(artifact) : undefined;
    },

    loadBinaryArtifact(input) {
      const artifact = artifacts.get(artifactKey(input));
      const data = binaryData.get(artifactKey(input));
      if (!artifact || !data) {
        return undefined;
      }
      return {
        artifact: cloneArtifact(artifact),
        data: new Uint8Array(data)
      };
    },

    listArtifacts(input) {
      return [...artifacts.values()]
        .filter((artifact) => matchesListInput(artifact, input))
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
        .map(cloneArtifact);
    },

    deleteArtifact(input) {
      artifacts.delete(artifactKey(input));
      binaryData.delete(artifactKey(input));
    }
  };
};

export const createFileArtifactService = (options: FileArtifactServiceOptions): ArtifactService => {
  const filePath = (input: ArtifactLookup) => path.join(options.directory, fileNameForArtifact(input));
  const binaryPath = (input: ArtifactLookup) => path.join(options.directory, blobPathForArtifact(input));

  const load = async (input: ArtifactLookup): Promise<ArtifactRecord | undefined> => {
    try {
      const content = await fs.readFile(filePath(input), "utf8");
      return normalizeArtifactRecord(JSON.parse(content) as ArtifactRecord);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  };

  const save = async (artifact: ArtifactRecord): Promise<void> => {
    await fs.mkdir(options.directory, { recursive: true });
    await fs.writeFile(filePath(artifact), JSON.stringify(cloneArtifact(artifact), null, 2), "utf8");
  };

  return {
    async saveArtifact(input) {
      const id = input.id ?? randomId("art");
      const lookup = {
        appName: input.appName,
        userId: input.userId,
        sessionId: input.sessionId,
        id
      };
      const existing = await load(lookup);
      assertExpectedRevision(existing, input.expectedRevision, "ArtifactRecord");
      const artifact = createArtifact({ ...input, id }, existing);
      await save(artifact);
      const existingBlob = binaryPath(lookup);
      await fs.unlink(existingBlob).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
      return cloneArtifact(artifact);
    },

    async saveBinaryArtifact(input) {
      const id = input.id ?? randomId("art");
      const lookup = {
        appName: input.appName,
        userId: input.userId,
        sessionId: input.sessionId,
        id
      };
      const bytes = bytesFromBinaryInput(input.data);
      const sha256 = input.sha256 ?? sha256Digest(bytes);
      const blobPath = blobPathForArtifact(lookup);
      const existing = await load(lookup);
      assertExpectedRevision(existing, input.expectedRevision, "ArtifactRecord");
      const artifact = createArtifact({
        ...input,
        id,
        data: null,
        encoding: "base64",
        size: bytes.byteLength,
        sha256,
        storageMode: "binary",
        blobPath
      }, existing);
      await fs.mkdir(path.dirname(binaryPath(lookup)), { recursive: true });
      await fs.writeFile(binaryPath(lookup), bytes);
      await save(artifact);
      return cloneArtifact(artifact);
    },

    async loadArtifact(input) {
      return load(input);
    },

    async loadBinaryArtifact(input) {
      const artifact = await load(input);
      if (!artifact || artifact.storageMode !== "binary" || !artifact.blobPath) {
        return undefined;
      }
      try {
        const data = await fs.readFile(path.join(options.directory, artifact.blobPath));
        return {
          artifact,
          data: new Uint8Array(data)
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    },

    async listArtifacts(input) {
      let entries: string[];
      try {
        entries = await fs.readdir(options.directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw error;
      }

      const artifacts: ArtifactRecord[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json")) {
          continue;
        }
        const content = await fs.readFile(path.join(options.directory, entry), "utf8");
        const artifact = normalizeArtifactRecord(JSON.parse(content) as ArtifactRecord);
        if (matchesListInput(artifact, input)) {
          artifacts.push(cloneArtifact(artifact));
        }
      }

      return artifacts.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    },

    async deleteArtifact(input) {
      const artifact = await load(input);
      try {
        await fs.unlink(filePath(input));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      if (artifact?.blobPath) {
        try {
          await fs.unlink(path.join(options.directory, artifact.blobPath));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      }
    }
  };
};

export const createSqliteArtifactService = (options: SqliteArtifactServiceOptions): ArtifactService => {
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
    const row = loadStatement.get([artifactKey(input)]);
    return parseArtifactJson(getRecordField(row, ["artifact_json", "artifactJson"]));
  };

  const save = (
    artifact: ArtifactRecord,
    options?: { existing?: ArtifactRecord; expectedRevision?: number }
  ): ArtifactRecord => {
    if (options?.expectedRevision !== undefined && options.existing) {
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
      if (sqliteMutationCount(result) === 0) {
        throw new ConflictError("ArtifactRecord revision conflict.");
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
    return cloneArtifact(artifact);
  };

  return {
    saveArtifact(input) {
      const id = input.id ?? randomId("art");
      const existing = load({
        appName: input.appName,
        userId: input.userId,
        sessionId: input.sessionId,
        id
      });
      assertExpectedRevision(existing, input.expectedRevision, "ArtifactRecord");
      return save(createArtifact({ ...input, id }, existing), {
        existing,
        expectedRevision: input.expectedRevision
      });
    },

    saveBinaryArtifact(input) {
      const id = input.id ?? randomId("art");
      const bytes = bytesFromBinaryInput(input.data);
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
        sha256: input.sha256 ?? sha256Digest(bytes),
        storageMode: "json"
      }, existing), {
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
        data: new Uint8Array(Buffer.from(artifact.data, "base64"))
      };
    },

    listArtifacts(input) {
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
      return rows.flatMap((row) => {
        const artifact = parseArtifactJson(getRecordField(row, ["artifact_json", "artifactJson"]));
        return artifact ? [artifact] : [];
      });
    },

    deleteArtifact(input) {
      deleteStatement.run([artifactKey(input)]);
    }
  };
};

export const createPostgresArtifactService = (options: PostgresArtifactServiceOptions): ArtifactService => {
  assertPostgresClient(options.client);
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
    await ensurePostgresTable(options.client, tableName, createSql);
    const result = await options.client.query<{ artifact_json?: ArtifactRecord; artifactJson?: ArtifactRecord }>(
      `SELECT artifact_json FROM ${tableName} WHERE artifact_key = $1`,
      [artifactKey(input)]
    );
    return parseArtifactJson(getRecordField(result.rows[0], ["artifact_json", "artifactJson"]));
  };

  const save = async (
    artifact: ArtifactRecord,
    saveOptions?: { existing?: ArtifactRecord; expectedRevision?: number }
  ): Promise<ArtifactRecord> => {
    await ensurePostgresTable(options.client, tableName, createSql);
    if (saveOptions?.expectedRevision !== undefined && saveOptions.existing) {
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
        throw new ConflictError("ArtifactRecord revision conflict.");
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
    return cloneArtifact(artifact);
  };

  return {
    async saveArtifact(input) {
      const id = input.id ?? randomId("art");
      const existing = await load({
        appName: input.appName,
        userId: input.userId,
        sessionId: input.sessionId,
        id
      });
      assertExpectedRevision(existing, input.expectedRevision, "ArtifactRecord");
      return save(createArtifact({ ...input, id }, existing), {
        existing,
        expectedRevision: input.expectedRevision
      });
    },

    async saveBinaryArtifact(input) {
      const id = input.id ?? randomId("art");
      const bytes = bytesFromBinaryInput(input.data);
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
        sha256: input.sha256 ?? sha256Digest(bytes),
        storageMode: "json"
      }, existing), {
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
        data: new Uint8Array(Buffer.from(artifact.data, "base64"))
      };
    },

    async listArtifacts(input) {
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
      return result.rows.flatMap((row) => {
        const artifact = parseArtifactJson(getRecordField(row, ["artifact_json", "artifactJson"]));
        return artifact ? [artifact] : [];
      });
    },

    async deleteArtifact(input) {
      await ensurePostgresTable(options.client, tableName, createSql);
      await options.client.query(`DELETE FROM ${tableName} WHERE artifact_key = $1`, [artifactKey(input)]);
    }
  };
};
