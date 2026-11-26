const UNSURE = Symbol("unsure");
type Verdict = boolean | typeof UNSURE;

const isOmittedProperty = (value: unknown) =>
  value === undefined || typeof value === "function" || typeof value === "symbol";

const isPlainObject = (value: object) => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isPlainArray = (value: unknown[]) =>
  Object.getPrototypeOf(value) === Array.prototype && !("toJSON" in value);

const compare = (left: unknown, right: unknown, depth: number): Verdict => {
  if (depth > 256) return UNSURE;
  // Boxed primitives and toJSON results can serialize like primitives, so a
  // type mismatch is left to JSON.stringify.
  if (typeof left === "string" || typeof left === "boolean") return typeof right === typeof left ? left === right : UNSURE;
  if (left === null) return right === null ? true : UNSURE;
  if (typeof left === "number") {
    // Non-finite numbers serialize as null, so leave them to JSON.stringify.
    if (!Number.isFinite(left) || typeof right !== "number" || !Number.isFinite(right)) return UNSURE;
    return left === right;
  }
  if (typeof left !== "object" || typeof right !== "object" || right === null) return UNSURE;

  if (Array.isArray(left)) {
    // Array subclasses and toJSON hooks can change the serialization.
    if (!Array.isArray(right) || !isPlainArray(left) || !isPlainArray(right)) return UNSURE;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      const verdict = compare(left[index], right[index], depth + 1);
      if (verdict !== true) return verdict;
    }
    return true;
  }

  // Class instances, toJSON methods and symbol keys follow JSON rules that
  // this fast path does not model.
  if (!isPlainObject(left) || !isPlainObject(right) || Array.isArray(right)) return UNSURE;
  if ("toJSON" in left || "toJSON" in right) return UNSURE;

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  let leftIndex = 0;
  let rightIndex = 0;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  while (true) {
    while (leftIndex < leftKeys.length && isOmittedProperty(leftRecord[leftKeys[leftIndex]!])) leftIndex += 1;
    while (rightIndex < rightKeys.length && isOmittedProperty(rightRecord[rightKeys[rightIndex]!])) rightIndex += 1;
    const leftDone = leftIndex >= leftKeys.length;
    const rightDone = rightIndex >= rightKeys.length;
    // A nested toJSON can drop a property, so key-level mismatches use the
    // exact serialization comparison. They end a prefix match, so this is rare.
    if (leftDone || rightDone) return leftDone && rightDone ? true : UNSURE;
    const key = leftKeys[leftIndex]!;
    if (key !== rightKeys[rightIndex]) return UNSURE;
    const verdict = compare(leftRecord[key], rightRecord[key], depth + 1);
    if (verdict !== true) return verdict;
    leftIndex += 1;
    rightIndex += 1;
  }
};

/**
 * Returns `JSON.stringify(left) === JSON.stringify(right)` without building
 * either string for plain JSON data. Values outside that subset fall back to
 * the exact serialization comparison.
 */
export const jsonEquivalent = (left: unknown, right: unknown): boolean => {
  const verdict = compare(left, right, 0);
  return verdict === UNSURE ? JSON.stringify(left) === JSON.stringify(right) : verdict;
};
