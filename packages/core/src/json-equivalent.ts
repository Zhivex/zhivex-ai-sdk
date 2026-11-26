// Reflection on a proxy may run user code or return values different from a
// normal property read. Runtimes without proxy detection use JSON.stringify.
const runtimeTypes = globalThis.process?.getBuiltinModule?.("node:util")?.types;

const sameDataProperty = (left: object, right: object, key: string, depth: number): boolean => {
  const a = Object.getOwnPropertyDescriptor(left, key);
  const b = Object.getOwnPropertyDescriptor(right, key);
  return !!a && !!b && Object.hasOwn(a, "value") && Object.hasOwn(b, "value")
    && samePlainJson(a.value, b.value, depth + 1);
};

// Prove equality only for ordinary data. For any mismatch or exotic value,
// serialize both roots so getters and toJSON run once in their original order.
const samePlainJson = (left: unknown, right: unknown, depth: number): boolean => {
  if (left === null || typeof left !== "object") {
    return left === right && typeof left !== "function" && typeof left !== "bigint";
  }
  if (right === null || typeof right !== "object" || depth > 256
      || !runtimeTypes || runtimeTypes.isProxy(left) || runtimeTypes.isProxy(right)) return false;

  // JSON.rawJSON wrappers have a null prototype and serialize verbatim.
  const prototype = Object.getPrototypeOf(left);
  if ((prototype !== Array.prototype && prototype !== Object.prototype)
      || prototype !== Object.getPrototypeOf(right)) return false;
  if ("toJSON" in left || "toJSON" in right) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || prototype !== Array.prototype
        || left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) {
      if (!sameDataProperty(left, right, String(i), depth)) return false;
    }
    return true;
  }

  // Boxed primitives can retain their internal value after a prototype change.
  if (prototype !== Object.prototype || runtimeTypes.isBoxedPrimitive(left) || runtimeTypes.isBoxedPrimitive(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key, i) =>
    key === rightKeys[i] && sameDataProperty(left, right, key, depth));
};

export const jsonEquivalent = (left: unknown, right: unknown): boolean =>
  samePlainJson(left, right, 0) || JSON.stringify(left) === JSON.stringify(right);
