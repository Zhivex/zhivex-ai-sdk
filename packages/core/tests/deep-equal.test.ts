import { isDeepStrictEqual as nodeIsDeepStrictEqual } from "node:util";

import { describe, expect, it } from "vitest";

import { isDeepStrictEqual } from "../src/deep-equal.js";

const samples: unknown[] = [
  null,
  undefined,
  0,
  -0,
  1,
  NaN,
  Infinity,
  "a",
  "",
  true,
  false,
  1n,
  [],
  [1, 2],
  [1, undefined],
  [, 1],
  {},
  { a: 1 },
  { a: undefined },
  { a: 1, b: { c: [true, "x"] } },
  { a: -0 },
  { a: NaN },
  new Date(0),
  new Date(Number.NaN),
  /a/gi,
  new Map([[{ id: 1 }, "value"]]),
  new Set([1, { ok: true }]),
  new Uint8Array([1, 2, 3]),
  new Float64Array([Number.NaN, -0]),
  Object.create(null)
];

describe("platform-neutral deep strict equality", () => {
  it("matches node:util for JSON-like values, views, and edge primitives", () => {
    for (const [leftIndex, left] of samples.entries()) {
      for (const [rightIndex, right] of samples.entries()) {
        expect(isDeepStrictEqual(left, right), `${leftIndex} vs ${rightIndex}`).toBe(nodeIsDeepStrictEqual(left, right));
      }
    }
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    const other: { self?: unknown } = {};
    other.self = other;
    expect(isDeepStrictEqual(cycle, other)).toBe(nodeIsDeepStrictEqual(cycle, other));
    expect(isDeepStrictEqual({ a: -0 }, JSON.parse(JSON.stringify({ a: -0 })))).toBe(false);
    expect(isDeepStrictEqual({ keep: undefined }, JSON.parse(JSON.stringify({ keep: undefined })))).toBe(false);
  });
});