import { expect, it } from "vitest";
import { z } from "zod";
import { createStructuredOutputPrompt } from "../src/index.js";
import { createStructuredOutputPrompt as corePrompt } from "@zhivex-ai/core";

it("exports Core's structured output prompt helper unchanged", () => {
  expect(createStructuredOutputPrompt).toBe(corePrompt);
  expect(createStructuredOutputPrompt(z.object({ ok: z.boolean() }))).toContain('"ok"');
});
