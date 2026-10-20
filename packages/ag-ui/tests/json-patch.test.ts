import { describe, expect, it } from "vitest";
import { applyJsonPatch } from "../src/json-patch.js";

const prototypeValue = (key: string): unknown =>
  (Object.prototype as unknown as Record<string, unknown>)[key];

describe("applyJsonPatch", () => {
  it("rejects __proto__, constructor, and prototype segments", () => {
    const beforeProto = prototypeValue("polluted");
    const document = { safe: { nested: true }, items: [{ ok: true }] };
    const forbidden = ["__proto__", "constructor", "prototype"];
    for (const segment of forbidden) {
      expect(() => applyJsonPatch(document, [{ op: "add", path: `/${segment}`, value: { polluted: true } }])).toThrow(/not allowed/);
      expect(() => applyJsonPatch(document, [{ op: "add", path: `/safe/${segment}`, value: { polluted: true } }])).toThrow(/not allowed/);
      expect(() => applyJsonPatch(document, [{ op: "add", path: `/safe/${segment}/polluted`, value: true }])).toThrow(/not allowed/);
      expect(() => applyJsonPatch(document, [{ op: "replace", path: `/items/0/${segment}`, value: true }])).toThrow(/not allowed/);
    }
    expect(prototypeValue("polluted")).toBe(beforeProto);
    expect(document).toEqual({ safe: { nested: true }, items: [{ ok: true }] });
  });

  it("accepts only in-bounds array indexes and dash for add", () => {
    expect(applyJsonPatch({ items: ["a"] }, [{ op: "add", path: "/items/-", value: "b" }])).toEqual({
      items: ["a", "b"]
    });
    expect(applyJsonPatch({ items: ["a"] }, [{ op: "add", path: "/items/1", value: "b" }])).toEqual({
      items: ["a", "b"]
    });
    expect(applyJsonPatch({ items: ["a", "b"] }, [{ op: "replace", path: "/items/0", value: "c" }])).toEqual({
      items: ["c", "b"]
    });
    expect(applyJsonPatch({ items: ["a", "b"] }, [{ op: "remove", path: "/items/1" }])).toEqual({
      items: ["a"]
    });

    const document = { items: ["a"] };
    expect(() => applyJsonPatch(document, [{ op: "remove", path: "/items/-" }])).toThrow(/only valid when adding/);
    expect(() => applyJsonPatch(document, [{ op: "replace", path: "/items/-" }])).toThrow(/only valid when adding/);
    expect(() => applyJsonPatch(document, [{ op: "add", path: "/items/2", value: "c" }])).toThrow(/out of bounds/);
    expect(() => applyJsonPatch(document, [{ op: "replace", path: "/items/1", value: "c" }])).toThrow(/out of bounds/);
    expect(() => applyJsonPatch(document, [{ op: "replace", path: "/items/01", value: "c" }])).toThrow(/invalid/);
    expect(() => applyJsonPatch(document, [{ op: "replace", path: "/items/-1", value: "c" }])).toThrow(/invalid/);
    expect(() => applyJsonPatch(document, [{ op: "replace", path: "/items/1.5", value: "c" }])).toThrow(/invalid/);
    expect(() => applyJsonPatch(document, [{ op: "replace", path: "/items/1e2", value: "c" }])).toThrow(/invalid/);
    expect(() => applyJsonPatch(document, [{ op: "add", path: "/items/0/nope", value: true }])).toThrow(/does not exist/);
    expect(document).toEqual({ items: ["a"] });
  });
});
