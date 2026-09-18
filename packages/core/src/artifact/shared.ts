import { createHash } from "node:crypto";
import { ConflictError, ValidationError } from "../errors.js";
import { createSecureId } from "#secure-id";
import { canonicalStoreKey } from "../store-key.js";
import type { JsonValue, PostgresClientLike, SqliteDatabaseLike } from "../types.js";

export const randomId = createSecureId;

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

export const artifactParts = (input: ArtifactLookup) =>
  [input.appName, input.userId, input.sessionId, input.id] as const;

export const artifactKey = (input: ArtifactLookup): string =>
  canonicalStoreKey("artifact", artifactParts(input));

export const legacyArtifactKey = (input: ArtifactLookup): string =>
  `${input.appName}:${input.userId}:${input.sessionId}:${input.id}`;

export const matchesArtifactLookup = (artifact: ArtifactRecord, input: ArtifactLookup): boolean =>
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

export const assertByteLimit = (actual: number, maximum: number, fieldName: string) => {
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

export const validateArtifactLookup = (input: ArtifactLookup) => {
  validateRequiredString(input.appName, "appName");
  validateRequiredString(input.userId, "userId");
  validateRequiredString(input.sessionId, "sessionId");
  validateRequiredString(input.id, "id");
};

export const validateArtifactListInput = (input: ArtifactListInput) => {
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

export const externalBlobReference = (metadata: Record<string, JsonValue> | undefined) => {
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

export const cloneArtifact = (artifact: ArtifactRecord): ArtifactRecord => cloneJson(normalizeArtifactRecord(artifact));

const binaryInputByteLength = (data: string | ArrayBuffer | Uint8Array): number =>
  typeof data === "string" ? utf8Bytes(data) : data.byteLength;

export const bytesFromBinaryInput = (
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

export const resolveBinarySha256 = (data: Uint8Array, expectedSha256: string | undefined): string => {
  validateArtifactMetadata({ sha256: expectedSha256 });
  const actualSha256 = sha256Digest(data);
  if (expectedSha256 !== undefined && expectedSha256.toLowerCase() !== actualSha256) {
    throw new ValidationError('The "sha256" artifact option does not match the binary data.');
  }
  return actualSha256;
};

export const assertExpectedRevision = (
  current: { revision: number } | undefined,
  expectedRevision: number | undefined,
  resource: string
) => {
  validateRevision(expectedRevision, "expectedRevision");
  if (expectedRevision !== undefined && (current?.revision ?? 0) !== expectedRevision) {
    throw new ConflictError(`${resource} revision conflict.`);
  }
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

export const base64Bytes = (value: string, maxBytes: number): Uint8Array => {
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

export const validateArtifactRecordLimits = (
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

export const parseArtifactJson = (
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

export const createArtifact = (
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

export const matchesListInput = (artifact: ArtifactRecord, input: ArtifactListInput): boolean =>
  artifact.appName === input.appName &&
  artifact.userId === input.userId &&
  artifact.sessionId === input.sessionId &&
  (input.workflowRunId === undefined || artifact.workflowRunId === input.workflowRunId) &&
  (input.workflowStepId === undefined || artifact.workflowStepId === input.workflowStepId) &&
  (input.agentRunId === undefined || artifact.agentRunId === input.agentRunId);

export const lookupFromArtifact = (artifact: ArtifactRecord): ArtifactLookup => ({
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
