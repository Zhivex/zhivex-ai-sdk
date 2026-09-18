import { createHash } from "node:crypto";

const canonicalTuple = (parts: readonly string[]): string => JSON.stringify(parts);

export const canonicalStoreKey = (namespace: string, parts: readonly string[]): string =>
  `${namespace}:v2:${createHash("sha256").update(canonicalTuple(parts)).digest("hex")}`;

export const canonicalStoreFileStem = (namespace: string, parts: readonly string[]): string =>
  canonicalStoreKey(namespace, parts).replaceAll(":", "_");

