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

const rejectForbiddenSegment = (segment: string): void => {
  if (segment === "__proto__") {
    throw new Error(`JSON pointer segment "${segment}" is not allowed.`);
  }
  if (segment === "constructor" || segment === "prototype") {
    throw new Error(`JSON pointer segment "${segment}" is not allowed.`);
  }
};

const parseArrayIndex = (
  segment: string,
  operation: AgUiJsonPatchOperation["op"],
  length: number
): number => {
  if (segment === "-") {
    if (operation !== "add") {
      throw new Error('JSON pointer "-" is only valid when adding to an array.');
    }
    return length;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(segment)) {
    throw new Error(`JSON pointer array index "${segment}" is invalid.`);
  }
  let index = 0;
  for (let cursor = 0; cursor < segment.length; cursor += 1) {
    index = index * 10 + (segment.charCodeAt(cursor) - 48);
    if (!Number.isSafeInteger(index)) {
      throw new Error(`JSON pointer array index "${segment}" is invalid.`);
    }
  }
  const maxInclusive = operation === "add" ? length : length - 1;
  if (index > maxInclusive) {
    throw new Error(`JSON pointer array index "${segment}" is out of bounds.`);
  }
  return index;
};

const childAt = (parent: unknown, segment: string, path: string): unknown => {
  if (segment === "__proto__") {
    throw new Error(`JSON pointer segment "${segment}" is not allowed.`);
  }
  rejectForbiddenSegment(segment);
  if (Array.isArray(parent)) {
    return parent[parseArrayIndex(segment, "replace", parent.length)];
  }
  if (!isPlainObject(parent) || !Object.prototype.hasOwnProperty.call(parent, segment)) {
    throw new Error(`JSON patch path "${path}" does not exist.`);
  }
  return parent[segment];
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
      parent = childAt(parent, segment, operation.path);
    }
    if (Array.isArray(parent)) {
      rejectForbiddenSegment(leaf);
      const index = parseArrayIndex(leaf, operation.op, parent.length);
      if (operation.op === "remove") parent.splice(index, 1);
      else if (operation.op === "add") parent.splice(index, 0, operation.value);
      else parent[index] = operation.value;
    } else if (isPlainObject(parent)) {
      if (leaf === "__proto__") {
        throw new Error(`JSON pointer segment "${leaf}" is not allowed.`);
      }
      rejectForbiddenSegment(leaf);
      if (operation.op === "remove") delete parent[leaf];
      else parent[leaf] = operation.value;
    } else {
      throw new Error(`JSON patch path "${operation.path}" does not exist.`);
    }
  }
  return current;
};
