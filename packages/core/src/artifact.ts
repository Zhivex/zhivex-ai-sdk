/** Compatibility facade. Backend implementations live in dedicated internal modules. */
export {
  ARTIFACT_SCHEMA_VERSION,
  type ArtifactServiceLimits,
  type ResolvedArtifactServiceLimits,
  DEFAULT_ARTIFACT_SERVICE_LIMITS,
  type ArtifactServiceOptions,
  type ArtifactLookup,
  type ArtifactListInput,
  type ArtifactSaveInput,
  type ArtifactEncoding,
  type ArtifactStorageMode,
  type ArtifactRecord,
  type ArtifactBinarySaveInput,
  type ArtifactBinaryLoadOutput,
  type Base64ArtifactDataInput,
  type Base64ArtifactData,
  type ArtifactService,
  type InMemoryArtifactServiceOptions,
  type FileArtifactServiceOptions,
  type SqliteArtifactServiceOptions,
  type PostgresArtifactServiceOptions,
  type ArtifactIntegrityIssue,
  type ArtifactIntegrityResult,
  type FileArtifactStoreInspectionIssue,
  type FileArtifactStoreInspection,
  type FileArtifactStoreCleanupOptions,
  type FileArtifactStoreCleanupResult,
  type FileArtifactStorePruneOptions,
  type FileArtifactStorePruneResult,
  type ExternalArtifactReferenceInput,
  type ExternalArtifactReference,
  type ArtifactRecordMigrationTarget,
  resolveArtifactServiceLimits,
  normalizeArtifactRecord,
  migrateArtifactRecord,
  createBase64ArtifactData,
  createExternalArtifactReference,
  verifyArtifactRecordIntegrity,
  verifyArtifactIntegrity
} from "./artifact/shared.js";
export {
  createInMemoryArtifactService
} from "./artifact/memory.js";
export {
  inspectFileArtifactStore,
  cleanupFileArtifactStore,
  pruneFileArtifactStore,
  createFileArtifactService
} from "./artifact/file.js";
export {
  createSqliteArtifactService
} from "./artifact/sqlite.js";
export {
  createPostgresArtifactService
} from "./artifact/postgres.js";
