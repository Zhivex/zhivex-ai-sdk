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

const rejectForbiddenSegment = (segment: string): never => {
  throw new Error(`JSON pointer segment "${segment}" is not allowed.`);
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

const copyRecord = (source: Record<string, unknown>): Record<string, unknown> => {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (key !== "__proto__") {
      copy[key] = source[key];
    }
  }
  return copy;
};

const recordWith = (source: Record<string, unknown>, segment: string, value: unknown): Record<string, unknown> => {
  const copy = copyRecord(source);
  if (segment !== "__proto__") {
    copy[segment] = value;
  }
  return copy;
};

const recordWithout = (source: Record<string, unknown>, segment: string): Record<string, unknown> => {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (key !== segment && key !== "__proto__") {
      copy[key] = source[key];
    }
  }
  return copy;
};

const applyOperation = (node: unknown, segments: readonly string[], operation: AgUiJsonPatchOperation): unknown => {
  if (segments.length === 0) {
    if (operation.op === "remove") {
      throw new Error("Cannot remove the JSON patch root.");
    }
    return operation.value;
  }
  const segment = segments[0]!;
  const rest = segments.slice(1);
  const atLeaf = rest.length === 0;
  if (segment !== "__proto__") {
    if (segment === "constructor" || segment === "prototype") {
      rejectForbiddenSegment(segment);
    }
    if (Array.isArray(node)) {
      const index = parseArrayIndex(segment, atLeaf ? operation.op : "replace", node.length);
      const copy = node.slice();
      if (atLeaf) {
        if (operation.op === "remove") copy.splice(index, 1);
        else if (operation.op === "add") copy.splice(index, 0, operation.value);
        else copy.splice(index, 1, operation.value);
        return copy;
      }
      copy.splice(index, 1, applyOperation(node[index], rest, operation));
      return copy;
    }
    if (isPlainObject(node)) {
      if (!atLeaf && !Object.prototype.hasOwnProperty.call(node, segment)) {
        throw new Error(`JSON patch path "${operation.path}" does not exist.`);
      }
      if (atLeaf && operation.op === "remove") return recordWithout(node, segment);
      const nextValue = atLeaf ? operation.value : applyOperation(node[segment], rest, operation);
      return recordWith(node, segment, nextValue);
    }
    throw new Error(`JSON patch path "${operation.path}" does not exist.`);
  }
  rejectForbiddenSegment(segment);
};

/** Applies the add, remove, and replace operations this adapter emits. */
export const applyJsonPatch = (document: unknown, operations: readonly AgUiJsonPatchOperation[]): unknown => {
  let current = JSON.parse(JSON.stringify(document)) as unknown;
  for (const operation of operations) {
    current = applyOperation(current, pointerSegments(operation.path), operation);
  }
  return current;
};
