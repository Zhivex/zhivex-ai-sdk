import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";

const canonicalTuple = (parts: readonly string[]): string => JSON.stringify(parts);

export const canonicalStoreKey = (namespace: string, parts: readonly string[]): string =>
  `${namespace}:v2:${createHash("sha256").update(canonicalTuple(parts)).digest("hex")}`;

export const canonicalStoreFileStem = (namespace: string, parts: readonly string[]): string =>
  canonicalStoreKey(namespace, parts).replaceAll(":", "_");

export const ensurePrivateDirectory = async (directory: string): Promise<void> => {
  const created = await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (created !== undefined) {
    await fs.chmod(directory, 0o700);
  }
};

export const writePrivateFile = async (
  filePath: string,
  data: string | Uint8Array,
  options: { flag?: "wx" } = {}
): Promise<void> => {
  if (options.flag !== "wx") {
    try {
      if ((await fs.lstat(filePath)).isSymbolicLink()) {
        throw new Error(`Refusing to replace symbolic link at ${filePath}.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
    const handle = await fs.open(temporaryPath, flags, 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(
        data,
        typeof data === "string" ? { encoding: "utf8" } : undefined
      );
      await handle.sync();
      await handle.close();
      await fs.rename(temporaryPath, filePath);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    return;
  }

  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_NOFOLLOW |
    constants.O_EXCL;
  const handle = await fs.open(filePath, flags, 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(
      data,
      typeof data === "string" ? { encoding: "utf8" } : undefined
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
};
