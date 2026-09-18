import { promises as fs } from "node:fs";
import path from "node:path";
import { ValidationError } from "../errors.js";
import { canonicalStoreFileStem, ensurePrivateDirectory, writePrivateFile } from "../store-security.js";
import {
  type ArtifactLookup,
  artifactParts,
  type ArtifactRecord,
  type FileArtifactServiceOptions,
  type FileArtifactStoreInspection,
  resolveArtifactServiceLimits,
  type FileArtifactStoreInspectionIssue,
  assertByteLimit,
  validateArtifactRecordLimits,
  normalizeArtifactRecord,
  artifactKey,
  externalBlobReference,
  type FileArtifactStoreCleanupOptions,
  type FileArtifactStoreCleanupResult,
  type FileArtifactStorePruneOptions,
  type FileArtifactStorePruneResult,
  type ArtifactService,
  validateArtifactLookup,
  matchesArtifactLookup,
  cloneArtifact,
  randomId,
  assertExpectedRevision,
  createArtifact,
  bytesFromBinaryInput,
  resolveBinarySha256,
  validateArtifactListInput,
  matchesListInput
} from "./shared.js";

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
