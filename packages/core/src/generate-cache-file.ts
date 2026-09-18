import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { ValidationError } from "./errors.js";
import { canonicalStoreFileStem, ensurePrivateDirectory, writePrivateFile } from "./store-security.js";
import type { GenerateResult } from "./types.js";
import type { GenerateCache } from "./middleware-runtime.js";

const DEFAULT_FILE_GENERATE_CACHE_MAX_KEY_BYTES = 1024 * 1024;
const DEFAULT_FILE_GENERATE_CACHE_MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const FILE_GENERATE_CACHE_READ_CHUNK_BYTES = 64 * 1024;
const FILE_GENERATE_CACHE_SCHEMA_VERSION = 1 as const;

const positiveFileCacheLimit = (
  value: number | undefined,
  fallback: number,
  name: "maxKeyBytes" | "maxEntryBytes"
): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new ValidationError(`The file generate cache "${name}" limit must be a positive safe integer.`);
  }
  return resolved;
};

const readFileWithinLimit = async (filePath: string, maxBytes: number): Promise<string | undefined> => {
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) {
      return undefined;
    }

    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    while (receivedBytes <= maxBytes) {
      const chunk = Buffer.allocUnsafe(
        Math.min(FILE_GENERATE_CACHE_READ_CHUNK_BYTES, maxBytes - receivedBytes + 1)
      );
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) {
        return Buffer.concat(chunks, receivedBytes).toString("utf8");
      }

      receivedBytes += bytesRead;
      if (receivedBytes > maxBytes) {
        return undefined;
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }

    return undefined;
  } finally {
    await handle.close();
  }
};

export const createFileGenerateCache = (options: {
  dir: string;
  /** Maximum UTF-8 cache-key size. Larger keys are treated as non-cacheable. Defaults to 1 MiB. */
  maxKeyBytes?: number;
  /** Maximum serialized result size. Larger entries are treated as non-cacheable. Defaults to 16 MiB. */
  maxEntryBytes?: number;
  /** Optional entry lifetime. Expired entries are treated as cache misses and removed. */
  ttlMs?: number;
}): GenerateCache => {
  const maxKeyBytes = positiveFileCacheLimit(
    options.maxKeyBytes,
    DEFAULT_FILE_GENERATE_CACHE_MAX_KEY_BYTES,
    "maxKeyBytes"
  );
  const maxEntryBytes = positiveFileCacheLimit(
    options.maxEntryBytes,
    DEFAULT_FILE_GENERATE_CACHE_MAX_ENTRY_BYTES,
    "maxEntryBytes"
  );
  if (options.ttlMs !== undefined && (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0)) {
    throw new ValidationError('The file generate cache "ttlMs" must be a positive safe integer.');
  }
  const keyIsWithinLimit = (key: string) => Buffer.byteLength(key, "utf8") <= maxKeyBytes;
  const getPath = (key: string) =>
    path.join(options.dir, `${canonicalStoreFileStem("generate-cache", [key])}.json`);

  return {
    scopeRequirement: "stable",
    async get(key) {
      if (!keyIsWithinLimit(key)) {
        return undefined;
      }

      try {
        const file = await readFileWithinLimit(getPath(key), maxEntryBytes);
        if (file === undefined) {
          return undefined;
        }
        try {
          const parsed: unknown = JSON.parse(file);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            return undefined;
          }
          const envelope = parsed as {
            schemaVersion?: unknown;
            createdAt?: unknown;
            value?: unknown;
          };
          if (
            envelope.schemaVersion !== FILE_GENERATE_CACHE_SCHEMA_VERSION ||
            typeof envelope.createdAt !== "number" ||
            !Number.isSafeInteger(envelope.createdAt) ||
            envelope.value === null ||
            typeof envelope.value !== "object" ||
            Array.isArray(envelope.value)
          ) {
            return undefined;
          }
          if (options.ttlMs !== undefined && Date.now() - envelope.createdAt >= options.ttlMs) {
            await fs.unlink(getPath(key)).catch(() => undefined);
            return undefined;
          }
          return envelope.value as GenerateResult;
        } catch (error) {
          if (error instanceof SyntaxError) {
            return undefined;
          }
          throw error;
        }
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err?.code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    },
    async set(key, value) {
      if (!keyIsWithinLimit(key)) {
        return;
      }

      let serialized: string;
      try {
        serialized = JSON.stringify({
          schemaVersion: FILE_GENERATE_CACHE_SCHEMA_VERSION,
          createdAt: Date.now(),
          value
        });
      } catch (error) {
        if (error instanceof TypeError) {
          return;
        }
        throw error;
      }
      if (Buffer.byteLength(serialized, "utf8") > maxEntryBytes) {
        return;
      }

      await ensurePrivateDirectory(options.dir);
      await fs.chmod(options.dir, 0o700);
      await writePrivateFile(getPath(key), serialized);
    }
  };
};

