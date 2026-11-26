import { describe, expect, it } from "vitest";

import { messagePrefixLength } from "../src/agent/common.js";
import { jsonEquivalent } from "../src/json-equivalent.js";
import type { ModelMessage } from "../src/types.js";

const expectSameAsStringify = (left: unknown, right: unknown) => {
  expect(jsonEquivalent(left, right)).toBe(JSON.stringify(left) === JSON.stringify(right));
};

describe("jsonEquivalent", () => {
  it("matches JSON.stringify equality for plain message data", () => {
    const message = {
      role: "assistant",
      parts: [
        { type: "text", text: "hello", providerMetadata: { a: 1, nested: [true, null, "x"] } },
        { type: "tool-call", toolCall: { id: "c1", name: "lookup", input: { q: "é ", n: 0 } } }
      ]
    };
    expectSameAsStringify(message, structuredClone(message));
    expectSameAsStringify(message, { ...message, role: "user" });
    expectSameAsStringify(message, { ...message, parts: message.parts.slice(1) });
    expectSameAsStringify({ a: 1, b: 2 }, { b: 2, a: 1 });
    expectSameAsStringify({ a: 1, b: undefined }, { a: 1 });
    expectSameAsStringify({ a: 1, f: () => 1 }, { a: 1 });
    expectSameAsStringify([undefined], [null]);
    expectSameAsStringify([1, 2], [1, 2, 3]);
    expectSameAsStringify(0, -0);
    expectSameAsStringify(Number.NaN, null);
    expectSameAsStringify({ n: Number.POSITIVE_INFINITY }, { n: null });
  });

  it("falls back to exact serialization for values outside plain JSON data", () => {
    const date = new Date(0);
    expectSameAsStringify({ at: date }, { at: date.toISOString() });
    expectSameAsStringify({ value: true }, { value: new Boolean(true) });
    expectSameAsStringify({ value: "x" }, { value: new String("x") });
    expectSameAsStringify({ a: { toJSON: () => undefined }, b: 1 }, { b: 1 });
    expectSameAsStringify({ a: { toJSON: () => [1] } }, { a: [1] });
    expectSameAsStringify([1], Object.assign([1], { toJSON: () => [2] }));
    expectSameAsStringify(Object.assign([1], { toJSON: () => [1] }), [1]);
    class Tagged extends Array<number> { toJSON() { return "tagged"; } }
    expectSameAsStringify(Tagged.from([1]), [1]);
    expectSameAsStringify(new Map([["a", 1]]), {});
    expectSameAsStringify(undefined, undefined);
    expect(() => jsonEquivalent({ big: 1n }, { big: 1n })).toThrow(TypeError);
  });

  it("keeps messagePrefixLength results unchanged", () => {
    const history: ModelMessage[] = [
      { role: "user", parts: [{ type: "text", text: "a".repeat(4096) }] },
      { role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "c1", name: "inspect", input: {} } }] }
    ];
    const next = [...structuredClone(history), { role: "user", parts: [{ type: "text", text: "more" }] } satisfies ModelMessage];
    expect(messagePrefixLength(history, next)).toBe(2);
    expect(messagePrefixLength(history, history.slice(0, 1))).toBe(0);
    const edited = structuredClone(next);
    (edited[1]!.parts[0] as { toolCall: { input: Record<string, unknown> } }).toolCall.input = { changed: true };
    expect(messagePrefixLength(history, edited)).toBe(0);
  });
});
