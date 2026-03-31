import { streamObject } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";
import { z } from "zod";

import { requiredEnv, section } from "../_shared";

const openai = createOpenAI({
  apiKey: requiredEnv("OPENAI_API_KEY")
});

const result = streamObject({
  model: openai("gpt-4o-mini"),
  prompt: "Return JSON for a support ticket triage result.",
  schema: z.object({
    priority: z.enum(["low", "medium", "high"]),
    team: z.string(),
    summary: z.string()
  }),
  mode: "native"
});

section("partialObjectStream");
for await (const partial of result.partialObjectStream) {
  console.log(partial);
}

const final = await result.collect();
section("final");
console.log(final.object);
