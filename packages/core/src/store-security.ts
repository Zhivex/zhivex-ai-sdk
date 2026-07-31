import { createHash } from "node:crypto";
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
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_NOFOLLOW |
    (options.flag === "wx" ? constants.O_EXCL : 0);
  const handle = await fs.open(filePath, flags, 0o600);
  try {
    // Tighten an existing file before replacing its contents. O_NOFOLLOW also
    // prevents a writable store directory from redirecting writes via symlink.
    await handle.chmod(0o600);
    if (options.flag !== "wx") {
      await handle.truncate(0);
    }
    await handle.writeFile(
      data,
      typeof data === "string" ? { encoding: "utf8" } : undefined
    );
  } finally {
    await handle.close();
  }
};
