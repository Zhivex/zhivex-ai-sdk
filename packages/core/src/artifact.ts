import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import { ConflictError, ValidationError } from "./errors.js";
import { assertPostgresClient } from "./postgres-client.js";
import { createSecureId } from "#secure-id";
import {
  canonicalStoreFileStem,
  canonicalStoreKey,
  ensurePrivateDirectory,
  writePrivateFile
} from "./store-security.js";
import type { JsonValue, PostgresClientLike, SqliteDatabaseLike, SqliteStatementLike } from "./types.js";

const randomId = createSecureId;
const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const MIB = 1024 * 1024;

export const ARTIFACT_SCHEMA_VERSION = 1 as const;

export interface ArtifactServiceLimits {
  maxJsonBytes?: number;
  maxTextBytes?: number;
  maxBase64Bytes?: number;
  maxBinaryBytes?: number;
  maxMetadataBytes?: number;
  maxRecordBytes?: number;
}

export interface ResolvedArtifactServiceLimits {
  maxJsonBytes: number;
  maxTextBytes: number;
  maxBase64Bytes: number;
  maxBinaryBytes: number;
  maxMetadataBytes: number;
  maxRecordBytes: number;
}

export const DEFAULT_ARTIFACT_SERVICE_LIMITS: Readonly<ResolvedArtifactServiceLimits> = Object.freeze({
  maxJsonBytes: MIB,
  maxTextBytes: MIB,
  maxBase64Bytes: 16 * MIB,
  maxBinaryBytes: 16 * MIB,
  maxMetadataBytes: 64 * 1024,
  maxRecordBytes: 24 * MIB
});

export interface ArtifactServiceOptions {
  limits?: ArtifactServiceLimits;
}

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

export interface InMemoryArtifactServiceOptions extends ArtifactServiceOptions {}

export interface FileArtifactServiceOptions extends ArtifactServiceOptions {
  directory: string;
}

export interface SqliteArtifactServiceOptions extends ArtifactServiceOptions {
  db: SqliteDatabaseLike;
  tableName?: string;
}

export interface PostgresArtifactServiceOptions extends ArtifactServiceOptions {
  client: PostgresClientLike;
  tableName?: string;
}

export interface ArtifactIntegrityIssue {
  type:
    | "missing-artifact"
    | "missing-blob"
    | "external-data-unavailable"
    | "size-mismatch"
    | "sha256-mismatch"
    | "invalid-base64"
    | "metadata-invalid";
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

const artifactParts = (input: ArtifactLookup) =>
  [input.appName, input.userId, input.sessionId, input.id] as const;
const artifactKey = (input: ArtifactLookup): string =>
  canonicalStoreKey("artifact", artifactParts(input));
const legacyArtifactKey = (input: ArtifactLookup): string =>
  `${input.appName}:${input.userId}:${input.sessionId}:${input.id}`;
const matchesArtifactLookup = (artifact: ArtifactRecord, input: ArtifactLookup): boolean =>
  artifact.appName === input.appName &&
  artifact.userId === input.userId &&
  artifact.sessionId === input.sessionId &&
  artifact.id === input.id;
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const artifactEncodings = new Set<ArtifactEncoding>(["json", "text", "base64"]);
const artifactStorageModes = new Set<ArtifactStorageMode>(["json", "binary"]);

const positiveSafeIntegerLimit = (value: number | undefined, fallback: number, name: string): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new ValidationError(`The "${name}" artifact limit must be a positive safe integer.`);
  }
  return resolved;
};

export const resolveArtifactServiceLimits = (
  limits: ArtifactServiceLimits = {}
): ResolvedArtifactServiceLimits => ({
  maxJsonBytes: positiveSafeIntegerLimit(
    limits.maxJsonBytes,
    DEFAULT_ARTIFACT_SERVICE_LIMITS.maxJsonBytes,
    "maxJsonBytes"
  ),
  maxTextBytes: positiveSafeIntegerLimit(
    limits.maxTextBytes,
    DEFAULT_ARTIFACT_SERVICE_LIMITS.maxTextBytes,
    "maxTextBytes"
  ),
  maxBase64Bytes: positiveSafeIntegerLimit(
    limits.maxBase64Bytes,
    DEFAULT_ARTIFACT_SERVICE_LIMITS.maxBase64Bytes,
    "maxBase64Bytes"
  ),
  maxBinaryBytes: positiveSafeIntegerLimit(
    limits.maxBinaryBytes,
    DEFAULT_ARTIFACT_SERVICE_LIMITS.maxBinaryBytes,
    "maxBinaryBytes"
  ),
  maxMetadataBytes: positiveSafeIntegerLimit(
    limits.maxMetadataBytes,
    DEFAULT_ARTIFACT_SERVICE_LIMITS.maxMetadataBytes,
    "maxMetadataBytes"
  ),
  maxRecordBytes: positiveSafeIntegerLimit(
    limits.maxRecordBytes,
    DEFAULT_ARTIFACT_SERVICE_LIMITS.maxRecordBytes,
    "maxRecordBytes"
  )
});

const jsonText = (value: unknown, fieldName: string): string => {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new ValidationError(`Artifact ${fieldName} must be JSON-serializable.`);
    }
    return serialized;
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }
    throw new ValidationError(`Artifact ${fieldName} must be JSON-serializable.`, { cause: error });
  }
};

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

const assertByteLimit = (actual: number, maximum: number, fieldName: string) => {
  if (actual > maximum) {
    throw new ValidationError(`Artifact ${fieldName} is ${actual} bytes and exceeds the ${maximum}-byte limit.`);
  }
};

const validateRequiredString = (value: unknown, fieldName: string) => {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`Artifact "${fieldName}" must be a non-empty string.`);
  }
};

const validateOptionalString = (value: unknown, fieldName: string) => {
  if (value !== undefined) {
    validateRequiredString(value, fieldName);
  }
};

const validateArtifactLookup = (input: ArtifactLookup) => {
  validateRequiredString(input.appName, "appName");
  validateRequiredString(input.userId, "userId");
  validateRequiredString(input.sessionId, "sessionId");
  validateRequiredString(input.id, "id");
};

const validateArtifactListInput = (input: ArtifactListInput) => {
  validateRequiredString(input.appName, "appName");
  validateRequiredString(input.userId, "userId");
  validateRequiredString(input.sessionId, "sessionId");
  validateOptionalString(input.workflowRunId, "workflowRunId");
  validateOptionalString(input.workflowStepId, "workflowStepId");
  validateOptionalString(input.agentRunId, "agentRunId");
};

const validateRevision = (revision: number | undefined, fieldName = "revision") => {
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) {
    throw new ValidationError(`Artifact "${fieldName}" must be a non-negative safe integer.`);
  }
};

const externalBlobReference = (metadata: Record<string, JsonValue> | undefined) => {
  const externalBlob = metadata?.externalBlob;
  if (!externalBlob || typeof externalBlob !== "object" || Array.isArray(externalBlob)) {
    return undefined;
  }
  const reference = externalBlob as Record<string, JsonValue>;
  return reference.managedBy === "application" &&
    typeof reference.uri === "string" &&
    reference.uri.length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(reference.uri)
    ? { uri: reference.uri }
    : undefined;
};

export const normalizeArtifactRecord = (value: unknown): ArtifactRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("ArtifactRecord must be an object.");
  }
  const artifact = value as Partial<ArtifactRecord> & { schemaVersion?: number };
  if (
    artifact.schemaVersion !== undefined &&
    (!Number.isSafeInteger(artifact.schemaVersion) || artifact.schemaVersion < 0 || artifact.schemaVersion > ARTIFACT_SCHEMA_VERSION)
  ) {
    throw new ValidationError(`Unsupported ArtifactRecord schemaVersion ${artifact.schemaVersion}.`);
  }
  if (!("data" in artifact)) {
    throw new ValidationError("ArtifactRecord is missing required fields.");
  }
  validateRequiredString(artifact.id, "id");
  validateRequiredString(artifact.appName, "appName");
  validateRequiredString(artifact.userId, "userId");
  validateRequiredString(artifact.sessionId, "sessionId");
  validateRequiredString(artifact.name, "name");
  validateRequiredString(artifact.contentType, "contentType");
  validateOptionalString(artifact.workflowRunId, "workflowRunId");
  validateOptionalString(artifact.workflowStepId, "workflowStepId");
  validateOptionalString(artifact.agentRunId, "agentRunId");
  if (artifact.revision !== undefined && (!Number.isSafeInteger(artifact.revision) || artifact.revision < 1)) {
    throw new ValidationError('Artifact "revision" must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(artifact.createdAt) || artifact.createdAt! < 0) {
    throw new ValidationError('Artifact "createdAt" must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(artifact.updatedAt) || artifact.updatedAt! < artifact.createdAt!) {
    throw new ValidationError('Artifact "updatedAt" must be a safe integer greater than or equal to "createdAt".');
  }
  if (artifact.encoding !== undefined && !artifactEncodings.has(artifact.encoding)) {
    throw new ValidationError('Artifact "encoding" must be "json", "text", or "base64".');
  }
  if (artifact.storageMode !== undefined && !artifactStorageModes.has(artifact.storageMode)) {
    throw new ValidationError('Artifact "storageMode" must be "json" or "binary".');
  }
  if (artifact.metadata !== undefined && (!artifact.metadata || typeof artifact.metadata !== "object" || Array.isArray(artifact.metadata))) {
    throw new ValidationError('Artifact "metadata" must be a JSON object.');
  }
  if (
    (artifact.storageMode ?? "json") !== "binary" &&
    (artifact.encoding === "base64" || artifact.encoding === "text") &&
    typeof artifact.data !== "string"
  ) {
    throw new ValidationError(`Artifact data must be a string when "encoding" is "${artifact.encoding}".`);
  }
  if ((artifact.storageMode ?? "json") === "binary" && artifact.data !== null) {
    throw new ValidationError('Artifact data must be null when "storageMode" is "binary".');
  }
  if (artifact.blobPath !== undefined && (artifact.storageMode !== "binary" || artifact.data !== null)) {
    throw new ValidationError('Artifact "blobPath" is only valid for separate binary storage.');
  }
  validateArtifactMetadata({ size: artifact.size, sha256: artifact.sha256 });
  jsonText(artifact.data, "data");
  if (artifact.metadata !== undefined) {
    jsonText(artifact.metadata, "metadata");
  }
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    revision: typeof artifact.revision === "number" ? artifact.revision : 1,
    id: artifact.id!,
    appName: artifact.appName!,
    userId: artifact.userId!,
    sessionId: artifact.sessionId!,
    workflowRunId: artifact.workflowRunId,
    workflowStepId: artifact.workflowStepId,
    agentRunId: artifact.agentRunId,
    name: artifact.name!,
    contentType: artifact.contentType!,
    data: cloneJson(artifact.data as JsonValue | string),
    encoding: artifact.encoding,
    size: artifact.size,
    sha256: artifact.sha256,
    storageMode: artifact.storageMode ?? "json",
    blobPath: artifact.blobPath,
    metadata: artifact.metadata ? cloneJson(artifact.metadata) : undefined,
    createdAt: artifact.createdAt!,
    updatedAt: artifact.updatedAt!
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

const binaryInputByteLength = (data: string | ArrayBuffer | Uint8Array): number =>
  typeof data === "string" ? utf8Bytes(data) : data.byteLength;

const bytesFromBinaryInput = (
  data: string | ArrayBuffer | Uint8Array,
  maxBytes: number
): Uint8Array => {
  assertByteLimit(binaryInputByteLength(data), maxBytes, "binary data");
  const buffer =
    typeof data === "string"
      ? Buffer.from(data, "utf8")
      : data instanceof Uint8Array
        ? Buffer.from(data)
        : Buffer.from(data);
  return new Uint8Array(buffer);
};

const sha256Digest = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

const resolveBinarySha256 = (data: Uint8Array, expectedSha256: string | undefined): string => {
  validateArtifactMetadata({ sha256: expectedSha256 });
  const actualSha256 = sha256Digest(data);
  if (expectedSha256 !== undefined && expectedSha256.toLowerCase() !== actualSha256) {
    throw new ValidationError('The "sha256" artifact option does not match the binary data.');
  }
  return actualSha256;
};

const assertExpectedRevision = (
  current: { revision: number } | undefined,
  expectedRevision: number | undefined,
  resource: string
) => {
  validateRevision(expectedRevision, "expectedRevision");
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

const encodedBase64Length = (decodedBytes: number): number => 4 * Math.ceil(decodedBytes / 3);

const base64Bytes = (value: string, maxBytes: number): Uint8Array => {
  assertByteLimit(utf8Bytes(value), encodedBase64Length(maxBytes), "base64 data");
  const normalized = value.replace(/\s/g, "");
  if (normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new ValidationError('Artifact data must be valid base64 when "encoding" is "base64".');
  }
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  const decodedBytes = normalized.length === 0 ? 0 : (normalized.length / 4) * 3 - padding;
  assertByteLimit(decodedBytes, maxBytes, "decoded base64 data");
  const bytes = new Uint8Array(Buffer.from(normalized, "base64"));
  if (bytes.byteLength !== decodedBytes) {
    throw new ValidationError('Artifact data must be valid base64 when "encoding" is "base64".');
  }
  return bytes;
};

const validateArtifactSaveInput = (
  input: ArtifactSaveInput,
  limits: ResolvedArtifactServiceLimits,
  internal: { managedBinary?: boolean } = {}
) => {
  validateRequiredString(input.appName, "appName");
  validateRequiredString(input.userId, "userId");
  validateRequiredString(input.sessionId, "sessionId");
  if (input.id !== undefined) {
    validateRequiredString(input.id, "id");
  }
  validateOptionalString(input.workflowRunId, "workflowRunId");
  validateOptionalString(input.workflowStepId, "workflowStepId");
  validateOptionalString(input.agentRunId, "agentRunId");
  validateRequiredString(input.name, "name");
  validateRequiredString(input.contentType, "contentType");
  validateRevision(input.expectedRevision, "expectedRevision");
  if (input.encoding !== undefined && !artifactEncodings.has(input.encoding)) {
    throw new ValidationError('Artifact "encoding" must be "json", "text", or "base64".');
  }
  if (input.storageMode !== undefined && !artifactStorageModes.has(input.storageMode)) {
    throw new ValidationError('Artifact "storageMode" must be "json" or "binary".');
  }
  if (input.metadata !== undefined && (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata))) {
    throw new ValidationError('Artifact "metadata" must be a JSON object.');
  }

  if (input.metadata !== undefined) {
    assertByteLimit(utf8Bytes(jsonText(input.metadata, "metadata")), limits.maxMetadataBytes, "metadata");
  }

  if ((input.storageMode ?? "json") === "binary") {
    if (input.data !== null) {
      throw new ValidationError('Artifact data must be null when "storageMode" is "binary".');
    }
    if (!internal.managedBinary && !externalBlobReference(input.metadata)) {
      throw new ValidationError(
        'Binary artifact metadata must contain an application-managed externalBlob reference.'
      );
    }
    return;
  }

  if (input.encoding === "base64") {
    if (typeof input.data !== "string") {
      throw new ValidationError('Artifact data must be a string when "encoding" is "base64".');
    }
    base64Bytes(input.data, limits.maxBase64Bytes);
    return;
  }
  if (input.encoding === "text" && typeof input.data !== "string") {
    throw new ValidationError('Artifact data must be a string when "encoding" is "text".');
  }

  if (typeof input.data === "string") {
    assertByteLimit(utf8Bytes(input.data), limits.maxTextBytes, "text data");
  } else {
    assertByteLimit(utf8Bytes(jsonText(input.data, "data")), limits.maxJsonBytes, "JSON data");
  }
};

const enrichArtifactMetadata = (
  input: ArtifactSaveInput,
  limits: ResolvedArtifactServiceLimits
): Pick<ArtifactSaveInput, "size" | "sha256"> => {
  validateArtifactMetadata(input);
  if (input.encoding !== "base64" || typeof input.data !== "string") {
    return {
      size: input.size,
      sha256: input.sha256
    };
  }

  const bytes = base64Bytes(input.data, limits.maxBase64Bytes);
  const actualSha256 = sha256Digest(bytes);

  if (input.size !== undefined && input.size !== bytes.byteLength) {
    throw new ValidationError('The "size" artifact option does not match the decoded base64 data.');
  }
  if (input.sha256 !== undefined && input.sha256.toLowerCase() !== actualSha256) {
    throw new ValidationError('The "sha256" artifact option does not match the decoded base64 data.');
  }

  return {
    size: input.size ?? bytes.byteLength,
    sha256: actualSha256
  };
};

const validateArtifactRecordLimits = (
  artifact: ArtifactRecord,
  limits: ResolvedArtifactServiceLimits
): ArtifactRecord => {
  assertByteLimit(utf8Bytes(jsonText(artifact, "record")), limits.maxRecordBytes, "record");
  if (artifact.metadata !== undefined) {
    assertByteLimit(utf8Bytes(jsonText(artifact.metadata, "metadata")), limits.maxMetadataBytes, "metadata");
  }
  if (artifact.storageMode !== "binary") {
    if (artifact.encoding === "base64") {
      if (typeof artifact.data !== "string") {
        throw new ValidationError('Artifact data must be a string when "encoding" is "base64".');
      }
      base64Bytes(artifact.data, limits.maxBase64Bytes);
    } else if (typeof artifact.data === "string") {
      assertByteLimit(utf8Bytes(artifact.data), limits.maxTextBytes, "text data");
    } else {
      assertByteLimit(utf8Bytes(jsonText(artifact.data, "data")), limits.maxJsonBytes, "JSON data");
    }
  }
  return artifact;
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

const parseArtifactJson = (
  value: unknown,
  limits: ResolvedArtifactServiceLimits
): ArtifactRecord | undefined => {
  if (!value) {
    return undefined;
  }

  if (typeof value === "string") {
    assertByteLimit(utf8Bytes(value), limits.maxRecordBytes, "record");
    return validateArtifactRecordLimits(normalizeArtifactRecord(JSON.parse(value) as ArtifactRecord), limits);
  }

  return validateArtifactRecordLimits(normalizeArtifactRecord(value), limits);
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

const createArtifact = (
  input: ArtifactSaveInput,
  limits: ResolvedArtifactServiceLimits,
  existing?: ArtifactRecord,
  internal?: { blobPath?: string; managedBinary?: boolean }
): ArtifactRecord => {
  validateArtifactSaveInput(input, limits, internal);
  const integrity = enrichArtifactMetadata(input, limits);
  const now = Date.now();
  const artifact: ArtifactRecord = {
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
    size: integrity.size,
    sha256: integrity.sha256,
    storageMode: input.storageMode ?? "json",
    blobPath: internal?.blobPath,
    metadata: input.metadata ? cloneJson(input.metadata) : undefined,
    createdAt: existing?.createdAt ?? now,
    updatedAt: existing ? Math.max(now, existing.updatedAt + 1) : now
  };
  assertByteLimit(utf8Bytes(jsonText(artifact, "record")), limits.maxRecordBytes, "record");
  return artifact;
};

const matchesListInput = (artifact: ArtifactRecord, input: ArtifactListInput): boolean =>
  artifact.appName === input.appName &&
  artifact.userId === input.userId &&
  artifact.sessionId === input.sessionId &&
  (input.workflowRunId === undefined || artifact.workflowRunId === input.workflowRunId) &&
  (input.workflowStepId === undefined || artifact.workflowStepId === input.workflowStepId) &&
  (input.agentRunId === undefined || artifact.agentRunId === input.agentRunId);

const fileNameForArtifact = (input: ArtifactLookup): string =>
  `${canonicalStoreFileStem("artifact", artifactParts(input))}.json`;

const blobPathForArtifact = (input: ArtifactLookup): string =>
  path.join("blobs", `${canonicalStoreFileStem("artifact", artifactParts(input))}.bin`);

const legacyFileNameForArtifact = (input: ArtifactLookup): string =>
  artifactParts(input).map((part) => encodeURIComponent(part)).join("__") + ".json";

const legacyBlobPathForArtifact = (input: ArtifactLookup): string =>
  path.join("blobs", artifactParts(input).map((part) => encodeURIComponent(part)).join("__") + ".bin");

const resolveFileArtifactBlobPath = (directory: string, artifact: ArtifactRecord): string | undefined => {
  if (!artifact.blobPath) {
    return undefined;
  }

  const normalizedBlobPath = path.normalize(artifact.blobPath);
  const expectedBlobPaths = new Set([
    blobPathForArtifact(artifact),
    legacyBlobPathForArtifact(artifact)
  ]);
  if (!expectedBlobPaths.has(normalizedBlobPath)) {
    throw new ValidationError(`Artifact "${artifact.id}" has an unsafe blobPath.`);
  }

  const root = path.resolve(directory);
  const resolved = path.resolve(root, artifact.blobPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new ValidationError(`Artifact "${artifact.id}" blobPath escapes the configured directory.`);
  }

  return resolved;
};

const lookupFromArtifact = (artifact: ArtifactRecord): ArtifactLookup => ({
  appName: artifact.appName,
  userId: artifact.userId,
  sessionId: artifact.sessionId,
  id: artifact.id
});

export const createBase64ArtifactData = (
  input: Base64ArtifactDataInput | string | ArrayBuffer | Uint8Array,
  limits: ArtifactServiceLimits = {}
): Base64ArtifactData => {
  const data = typeof input === "object" && "data" in input ? input.data : input;
  const resolvedLimits = resolveArtifactServiceLimits(limits);
  const buffer = Buffer.from(bytesFromBinaryInput(data, resolvedLimits.maxBase64Bytes));
  return {
    data: buffer.toString("base64"),
    encoding: "base64",
    size: buffer.byteLength
  };
};

export const createExternalArtifactReference = (
  input: ExternalArtifactReferenceInput,
  limits: ArtifactServiceLimits = {}
): ExternalArtifactReference => {
  const resolvedLimits = resolveArtifactServiceLimits(limits);
  validateArtifactMetadata(input);
  if (!input.uri || /[\u0000-\u001f\u007f]/.test(input.uri)) {
    throw new ValidationError('The "uri" external artifact reference option is required.');
  }
  if (input.metadata !== undefined && (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata))) {
    throw new ValidationError('Artifact "metadata" must be a JSON object.');
  }
  const reference: ExternalArtifactReference = {
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
  assertByteLimit(
    utf8Bytes(jsonText(reference.metadata, "metadata")),
    resolvedLimits.maxMetadataBytes,
    "metadata"
  );
  return reference;
};

export const verifyArtifactRecordIntegrity = (
  record: ArtifactRecord,
  data?: Uint8Array,
  limits: ArtifactServiceLimits = {}
): ArtifactIntegrityResult => {
  const artifact = normalizeArtifactRecord(record);
  const resolvedLimits = resolveArtifactServiceLimits(limits);
  const issues: ArtifactIntegrityIssue[] = [];
  let bytes = data;
  let decodedInlineBase64 = false;

  if (!bytes && artifact.encoding === "base64" && typeof artifact.data === "string") {
    try {
      bytes = base64Bytes(artifact.data, resolvedLimits.maxBase64Bytes);
      decodedInlineBase64 = true;
    } catch {
      issues.push({
        type: "invalid-base64",
        message: `Artifact "${artifact.id}" contains invalid base64 data.`
      });
    }
  }

  if (bytes && !decodedInlineBase64) {
    try {
      assertByteLimit(bytes.byteLength, resolvedLimits.maxBinaryBytes, "binary data");
    } catch (error) {
      issues.push({
        type: "metadata-invalid",
        message: error instanceof Error ? error.message : `Artifact "${artifact.id}" binary data exceeds its limit.`
      });
      bytes = undefined;
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
  lookup: ArtifactLookup,
  limits: ArtifactServiceLimits = {}
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
      const external = externalBlobReference(artifact.metadata);
      return {
        ok: false,
        artifact,
        issues: [{
          type: external ? "external-data-unavailable" : "missing-blob",
          message: external
            ? `Artifact "${lookup.id}" uses application-managed external data at "${external.uri}".`
            : `Artifact "${lookup.id}" binary blob was not found.`
        }]
      };
    }
    return verifyArtifactRecordIntegrity(binary.artifact, binary.data, limits);
  }

  return verifyArtifactRecordIntegrity(artifact, undefined, limits);
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
  const limits = resolveArtifactServiceLimits(options.limits);
  const artifacts = new Map<string, ArtifactRecord>();
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
      const stat = await fs.stat(metadataPath);
      assertByteLimit(stat.size, limits.maxRecordBytes, "record");
      const artifact = validateArtifactRecordLimits(
        normalizeArtifactRecord(JSON.parse(await fs.readFile(metadataPath, "utf8")) as ArtifactRecord),
        limits
      );
      const fullBlobPath = resolveFileArtifactBlobPath(options.directory, artifact);
      const key = artifactKey(artifact);
      if (!artifacts.has(key) || entry === fileNameForArtifact(artifact)) {
        artifacts.set(key, artifact);
      }
      if (artifact.blobPath) {
        referencedBlobPaths.add(path.normalize(artifact.blobPath));
      }
      if (artifact.storageMode === "binary") {
        if (!artifact.blobPath) {
          if (!externalBlobReference(artifact.metadata)) {
            issues.push({
              type: "missing-blob",
              path: metadataPath,
              artifact,
              message: `Artifact "${artifact.id}" has no blobPath.`
            });
          }
        } else {
          try {
            await fs.stat(fullBlobPath!);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              issues.push({
                type: "missing-blob",
                path: fullBlobPath!,
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
    artifacts: [...artifacts.values()].sort(
      (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)
    ),
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
  const inspection = await inspectFileArtifactStore({
    directory: options.directory,
    limits: options.limits
  });
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
        await fs.unlink(resolveFileArtifactBlobPath(options.directory, artifact)!).catch((error: NodeJS.ErrnoException) => {
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

export const createInMemoryArtifactService = (
  options: InMemoryArtifactServiceOptions = {}
): ArtifactService => {
  const limits = resolveArtifactServiceLimits(options.limits);
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
      validateArtifactLookup(lookup);
      const existing = artifacts.get(artifactKey(lookup));
      assertExpectedRevision(existing, input.expectedRevision, "ArtifactRecord");
      const artifact = createArtifact({ ...input, id }, limits, existing);
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
      validateArtifactLookup(lookup);
      const bytes = bytesFromBinaryInput(input.data, limits.maxBinaryBytes);
      const sha256 = resolveBinarySha256(bytes, input.sha256);
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
      }, limits, existing, { managedBinary: true });
      artifacts.set(artifactKey(lookup), cloneArtifact(artifact));
      binaryData.set(artifactKey(lookup), new Uint8Array(bytes));
      return cloneArtifact(artifact);
    },

    loadArtifact(input) {
      validateArtifactLookup(input);
      const artifact = artifacts.get(artifactKey(input));
      return artifact ? cloneArtifact(artifact) : undefined;
    },

    loadBinaryArtifact(input) {
      validateArtifactLookup(input);
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
      validateArtifactListInput(input);
      return [...artifacts.values()]
        .filter((artifact) => matchesListInput(artifact, input))
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
        .map(cloneArtifact);
    },

    deleteArtifact(input) {
      validateArtifactLookup(input);
      artifacts.delete(artifactKey(input));
      binaryData.delete(artifactKey(input));
    }
  };
};

export const createFileArtifactService = (options: FileArtifactServiceOptions): ArtifactService => {
  const limits = resolveArtifactServiceLimits(options.limits);
  const filePath = (input: ArtifactLookup) => path.join(options.directory, fileNameForArtifact(input));
  const binaryPath = (input: ArtifactLookup) => path.join(options.directory, blobPathForArtifact(input));
  const legacyFilePath = (input: ArtifactLookup) => path.join(options.directory, legacyFileNameForArtifact(input));

  const load = async (input: ArtifactLookup): Promise<ArtifactRecord | undefined> => {
    validateArtifactLookup(input);
    for (const candidate of [filePath(input), legacyFilePath(input)]) {
      try {
        const stat = await fs.stat(candidate);
        assertByteLimit(stat.size, limits.maxRecordBytes, "record");
        const content = await fs.readFile(candidate, "utf8");
        const artifact = validateArtifactRecordLimits(
          normalizeArtifactRecord(JSON.parse(content) as ArtifactRecord),
          limits
        );
        if (!matchesArtifactLookup(artifact, input)) {
          continue;
        }
        resolveFileArtifactBlobPath(options.directory, artifact);
        return artifact;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
    return undefined;
  };

  const save = async (artifact: ArtifactRecord): Promise<void> => {
    await ensurePrivateDirectory(options.directory);
    await writePrivateFile(filePath(artifact), JSON.stringify(cloneArtifact(artifact)));
    try {
      const legacyArtifact = normalizeArtifactRecord(
        JSON.parse(await fs.readFile(legacyFilePath(artifact), "utf8")) as ArtifactRecord
      );
      if (matchesArtifactLookup(legacyArtifact, artifact)) {
        const legacyBlob = resolveFileArtifactBlobPath(options.directory, legacyArtifact);
        await fs.unlink(legacyFilePath(artifact));
        if (legacyBlob && legacyArtifact.blobPath !== artifact.blobPath) {
          await fs.unlink(legacyBlob).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") {
              throw error;
            }
          });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
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
      validateArtifactLookup(lookup);
      const existing = await load(lookup);
      assertExpectedRevision(existing, input.expectedRevision, "ArtifactRecord");
      const artifact = createArtifact({ ...input, id }, limits, existing);
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
      validateArtifactLookup(lookup);
      const bytes = bytesFromBinaryInput(input.data, limits.maxBinaryBytes);
      const sha256 = resolveBinarySha256(bytes, input.sha256);
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
        storageMode: "binary"
      }, limits, existing, { blobPath, managedBinary: true });
      await ensurePrivateDirectory(path.dirname(binaryPath(lookup)));
      await writePrivateFile(binaryPath(lookup), bytes);
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
        const resolvedBlobPath = resolveFileArtifactBlobPath(options.directory, artifact)!;
        const stat = await fs.stat(resolvedBlobPath);
        assertByteLimit(stat.size, limits.maxBinaryBytes, "binary data");
        const data = await fs.readFile(resolvedBlobPath);
        assertByteLimit(data.byteLength, limits.maxBinaryBytes, "binary data");
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
      validateArtifactListInput(input);
      let entries: string[];
      try {
        entries = await fs.readdir(options.directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw error;
      }

      const artifacts = new Map<string, ArtifactRecord>();
      for (const entry of entries) {
        if (!entry.endsWith(".json")) {
          continue;
        }
        const metadataPath = path.join(options.directory, entry);
        const stat = await fs.stat(metadataPath);
        assertByteLimit(stat.size, limits.maxRecordBytes, "record");
        const content = await fs.readFile(metadataPath, "utf8");
        const artifact = validateArtifactRecordLimits(
          normalizeArtifactRecord(JSON.parse(content) as ArtifactRecord),
          limits
        );
        resolveFileArtifactBlobPath(options.directory, artifact);
        if (matchesListInput(artifact, input)) {
          const key = artifactKey(artifact);
          if (!artifacts.has(key) || entry === fileNameForArtifact(artifact)) {
            artifacts.set(key, cloneArtifact(artifact));
          }
        }
      }

      return [...artifacts.values()].sort(
        (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)
      );
    },

    async deleteArtifact(input) {
      validateArtifactLookup(input);
      const artifact = await load(input);
      await fs.unlink(filePath(input)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
      try {
        const legacyArtifact = normalizeArtifactRecord(
          JSON.parse(await fs.readFile(legacyFilePath(input), "utf8")) as ArtifactRecord
        );
        if (matchesArtifactLookup(legacyArtifact, input)) {
          await fs.unlink(legacyFilePath(input));
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      if (artifact?.blobPath) {
        try {
          await fs.unlink(resolveFileArtifactBlobPath(options.directory, artifact)!);
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
