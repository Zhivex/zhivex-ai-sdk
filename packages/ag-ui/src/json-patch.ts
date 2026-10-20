import type { AgUiJsonPatchOperation } from "./events.js";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pointerToken = (token: string): string =>
  token.replaceAll("~", "~0").replaceAll("/", "~1");

const decodePointer = (token: string): string =>
  token.replaceAll("~1", "/").replaceAll("~0", "~");

/**
 * RFC 6902 patch limited to add, remove, and replace.
 * Arrays are replaced as a whole so order changes stay valid patches.
 */
export const diffJson = (before: unknown, after: unknown, path = ""): AgUiJsonPatchOperation[] => {
  if (Object.is(before, after)) return [];
  if (isPlainObject(before) && isPlainObject(after)) {
    const operations: AgUiJsonPatchOperation[] = [];
    for (const key of Object.keys(before)) {
      if (!Object.prototype.hasOwnProperty.call(after, key)) {
        operations.push({ op: "remove", path: `${path}/${pointerToken(key)}` });
      }
    }
    for (const key of Object.keys(after)) {
      const nextPath = `${path}/${pointerToken(key)}`;
      if (!Object.prototype.hasOwnProperty.call(before, key)) {
        operations.push({ op: "add", path: nextPath, value: after[key] });
      } else {
        operations.push(...diffJson(before[key], after[key], nextPath));
      }
    }
    return operations;
  }
  return [{ op: "replace", path, value: after }];
};

const pointerSegments = (path: string): string[] => {
  if (path === "") return [];
  if (!path.startsWith("/")) {
    throw new Error(`Invalid JSON pointer "${path}".`);
  }
  return path.slice(1).split("/").map(decodePointer);
};

/** Applies the add, remove, and replace operations this adapter emits. */
export const applyJsonPatch = (document: unknown, operations: readonly AgUiJsonPatchOperation[]): unknown => {
  let current = JSON.parse(JSON.stringify(document)) as unknown;
  for (const operation of operations) {
    const segments = pointerSegments(operation.path);
    if (segments.length === 0) {
      if (operation.op === "remove") {
        throw new Error("Cannot remove the JSON patch root.");
      }
      current = operation.value;
      continue;
    }
    if (!isPlainObject(current) && !Array.isArray(current)) {
      throw new Error(`JSON patch path "${operation.path}" does not exist.`);
    }
    const parentSegments = segments.slice(0, -1);
    const leaf = segments.at(-1)!;
    let parent: unknown = current;
    for (const segment of parentSegments) {
      if (Array.isArray(parent)) {
        parent = parent[Number(segment)];
      } else if (isPlainObject(parent)) {
        parent = parent[segment];
      } else {
        throw new Error(`JSON patch path "${operation.path}" does not exist.`);
      }
    }
    if (Array.isArray(parent)) {
      const index = Number(leaf);
      if (operation.op === "remove") parent.splice(index, 1);
      else if (operation.op === "add") parent.splice(index, 0, operation.value);
      else parent[index] = operation.value;
    } else if (isPlainObject(parent)) {
      if (operation.op === "remove") delete parent[leaf];
      else parent[leaf] = operation.value;
    } else {
      throw new Error(`JSON patch path "${operation.path}" does not exist.`);
    }
  }
  return current;
};
