import { describe, expect, it } from "vitest";

import { experimentalRawProviderOptions } from "../src/index.js";

describe("experimental raw provider options", () => {
  it("returns an immutable JSON-compatible copy", () => {
    const source = {
      preview_control: "enabled",
      nested: { values: [1, true, null] }
    };
    const options = experimentalRawProviderOptions(source);

    expect(options).toEqual(source);
    expect(options).not.toBe(source);
    expect(Object.isFrozen(options)).toBe(true);
    expect(Object.isFrozen(options.nested)).toBe(true);
    expect(Object.isFrozen(options.nested.values)).toBe(true);
  });

  it("rejects functions, non-finite numbers, class instances, and cycles", () => {
    expect(() => experimentalRawProviderOptions({ value: Number.NaN })).toThrow("finite JSON numbers");
    expect(() => experimentalRawProviderOptions({ callback: () => true })).toThrow("JSON-compatible");
    expect(() => experimentalRawProviderOptions({ date: new Date() })).toThrow("plain objects");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => experimentalRawProviderOptions(circular)).toThrow("circular references");
  });

  it("rejects prototype mutation keys", () => {
    const unsafe = JSON.parse('{"constructor":{"prototype":{"admin":true}}}') as Record<string, unknown>;
    expect(() => experimentalRawProviderOptions(unsafe)).toThrow("constructor is not allowed");
  });

  it("does not execute accessors or ignore symbol properties", () => {
    const getter = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        throw new Error("must not execute");
      }
    });
    expect(() => experimentalRawProviderOptions(getter)).toThrow("must be a data property");

    const symbol = Symbol("hidden");
    expect(() => experimentalRawProviderOptions({ [symbol]: true })).toThrow("symbol properties");
  });
});
