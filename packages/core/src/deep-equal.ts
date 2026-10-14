const typedArrayTags = new Set([
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array"
]);

const tag = (value: object) => Object.prototype.toString.call(value);

const enumerableKeys = (value: object): Array<string | symbol> => [
  ...Object.keys(value),
  ...Object.getOwnPropertySymbols(value).filter((key) => Object.prototype.propertyIsEnumerable.call(value, key))
];

const sameKeys = (left: object, right: object) => {
  const leftKeys = enumerableKeys(left);
  const rightKeys = new Set(enumerableKeys(right));
  return leftKeys.length === rightKeys.size && leftKeys.every((key) => rightKeys.has(key));
};

const bytesEqual = (left: ArrayBufferView, right: ArrayBufferView) => {
  if (left.byteLength !== right.byteLength) return false;
  const leftBytes = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
  const rightBytes = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
  return leftBytes.every((value, index) => value === rightBytes[index]);
};

/**
 * Platform-neutral equivalent of Node's `util.isDeepStrictEqual` for the
 * values the agent runtime compares. Object identity uses SameValue, so NaN
 * matches NaN and -0 does not match 0.
 */
export const isDeepStrictEqual = (left: unknown, right: unknown): boolean => {
  const seen = new WeakMap<object, object>();

  const equal = (a: unknown, b: unknown): boolean => {
    if (Object.is(a, b)) return true;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
    if (seen.get(a) === b) return true;
    seen.set(a, b);

    if (a instanceof Date || b instanceof Date) {
      return a instanceof Date && b instanceof Date && Object.is(a.getTime(), b.getTime());
    }
    if (a instanceof RegExp || b instanceof RegExp) {
      return a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags;
    }
    if (a instanceof Number || a instanceof String || a instanceof Boolean || a instanceof BigInt) {
      return a.constructor === b.constructor && Object.is(a.valueOf(), (b as typeof a).valueOf());
    }
    if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
      if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || tag(a) !== tag(b)) return false;
      if (!typedArrayTags.has(tag(a).slice(8, -1)) && tag(a) !== "[object DataView]") return false;
      return bytesEqual(a, b) && sameKeys(a, b);
    }
    if (a instanceof ArrayBuffer || b instanceof ArrayBuffer) {
      return a instanceof ArrayBuffer && b instanceof ArrayBuffer && bytesEqual(new Uint8Array(a), new Uint8Array(b));
    }
    if (a instanceof Map || b instanceof Map) {
      if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false;
      for (const [key, value] of a) {
        const match = [...b.keys()].find((candidate) => equal(key, candidate));
        if (match === undefined || !b.has(match) || !equal(value, b.get(match))) return false;
      }
      return true;
    }
    if (a instanceof Set || b instanceof Set) {
      if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false;
      const pending = [...b];
      for (const value of a) {
        const index = pending.findIndex((candidate) => equal(value, candidate));
        if (index < 0) return false;
        pending.splice(index, 1);
      }
      return true;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      for (let index = 0; index < a.length; index += 1) {
        if (Object.hasOwn(a, index) !== Object.hasOwn(b, index)) return false;
        if (Object.hasOwn(a, index) && !equal(a[index], b[index])) return false;
      }
    }
    if (!sameKeys(a, b)) return false;
    return enumerableKeys(a).every((key) => equal((a as Record<string | symbol, unknown>)[key], (b as Record<string | symbol, unknown>)[key]));
  };

  return equal(left, right);
};
