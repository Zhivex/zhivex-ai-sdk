import { ValidationError } from "./errors.js";

declare const experimentalRawProviderOptionsBrand: unique symbol;

type DeepReadonly<T> = T extends readonly (infer TItem)[]
  ? readonly DeepReadonly<TItem>[]
  : T extends object
    ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
    : T;

/**
 * Explicitly branded provider passthrough options.
 *
 * The SDK validates that the input is a plain JSON-like record, but the
 * provider remains responsible for deciding which fields are accepted.
 */
export type ExperimentalRawProviderOptions<T extends Record<string, unknown> = Record<string, unknown>> =
  DeepReadonly<T> & { readonly [experimentalRawProviderOptionsBrand]: true };

const cloneRawValue = (value: unknown, path: string, seen: Set<object>): unknown => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ValidationError(`${path} must contain only finite JSON numbers.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new ValidationError(`${path} must not contain circular references.`);
    }
    seen.add(value);
    const cloned = value.map((item, index) => cloneRawValue(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return Object.freeze(cloned);
  }
  if (typeof value !== "object" || value === null) {
    throw new ValidationError(`${path} must contain JSON-compatible values.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ValidationError(`${path} must contain plain objects only.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new ValidationError(`${path} must not contain symbol properties.`);
  }
  if (seen.has(value)) {
    throw new ValidationError(`${path} must not contain circular references.`);
  }
  seen.add(value);
  const cloned: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (!key || /[\u0000-\u001f\u007f]/u.test(key)) {
      throw new ValidationError(`${path} contains an invalid property name.`);
    }
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new ValidationError(`${path}.${key} is not allowed.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new ValidationError(`${path}.${key} must be a data property.`);
    }
    const item = descriptor.value;
    cloned[key] = cloneRawValue(item, `${path}.${key}`, seen);
  }
  seen.delete(value);
  return Object.freeze(cloned);
};

/**
 * Marks arbitrary provider request fields as an intentional Experimental
 * dependency and returns an immutable, JSON-compatible copy.
 */
export const experimentalRawProviderOptions = <T extends Record<string, unknown>>(
  options: T
): ExperimentalRawProviderOptions<T> => {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new ValidationError("Raw provider options must be a plain object.");
  }
  return cloneRawValue(options, "providerOptions", new Set()) as ExperimentalRawProviderOptions<T>;
};
