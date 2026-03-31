import { generateObject } from "@zhivex-ai/sdk";
import { createGemini } from "@zhivex-ai/gemini";
import { z } from "zod";

import { requiredEnv } from "../_shared";

const gemini = createGemini({
  apiKey: requiredEnv("GEMINI_API_KEY")
});

const releaseSchema = z.object({
  title: z.string(),
  audience: z.enum(["developers", "product", "support"]),
  highlights: z.array(z.string()).min(2)
});

const result = await generateObject({
  model: gemini("gemini-2.0-flash"),
  prompt: "Create a release summary for a provider-agnostic AI SDK update.",
  schema: releaseSchema,
  mode: "native",
  schemaName: "release_summary"
});

console.log(result.object);
console.log(result.objectMode);
