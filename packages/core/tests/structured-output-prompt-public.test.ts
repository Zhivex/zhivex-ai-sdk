import { expect, it } from "vitest";
import { z } from "zod";
import { createStructuredOutputPrompt, ValidationError } from "../src/index.js";

it("exposes the shared prompted JSON schema contract", () => {
  const prompt = createStructuredOutputPrompt(z.object({ enabled: z.boolean() }), { name: "Settings", description: "Feature settings" });
  expect(prompt).toContain("Output name: Settings");
  expect(prompt).toContain("Output description: Feature settings");
  const schema = JSON.parse(prompt.split("JSON Schema:\n")[1]!);
  expect(schema.properties.enabled.type).toBe("boolean");
  expect(schema.required).toEqual(["enabled"]);
});

it("rejects schemas that cannot be represented instead of dropping constraints", () => {
  expect(() => createStructuredOutputPrompt(z.object({ callback: z.custom<() => void>() }))).toThrow(ValidationError);
});
