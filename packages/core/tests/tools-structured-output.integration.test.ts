import { describe, expect, it } from "vitest";
import { z } from "zod";

import { generateObject, generateText, tool } from "../src/index.js";
import { integrationLanguageProviders } from "./integration-registry.js";

const toolProviders = integrationLanguageProviders.filter((provider) => provider.supports.tools);
const structuredOutputProviders = integrationLanguageProviders.filter((provider) => provider.supports.structuredOutputMode);

const describeToolIntegration = toolProviders.length ? (describe.sequential ?? describe.skip) : describe.skip;
const describeStructuredOutputIntegration = structuredOutputProviders.length ? (describe.sequential ?? describe.skip) : describe.skip;

describeToolIntegration("tool calling capability integration", () => {
  for (const provider of toolProviders) {
    it(`${provider.name} runs the common multi-step tool loop`, async () => {
      const result = await generateText({
        model: provider.createModel(),
        prompt: "Call the sum tool with a=2 and b=3, then answer with only the numeric result.",
        ...(provider.omitTemperature ? {} : { temperature: provider.temperature ?? 0 }),
        maxTokens: provider.toolMaxTokens ?? 32,
        maxSteps: 2,
        tools: {
          sum: tool({
            name: "sum",
            description: "Adds two integers and returns the total.",
            schema: z.object({
              a: z.number().int(),
              b: z.number().int()
            }),
            execute: ({ a, b }) => ({ total: a + b })
          })
        },
        toolChoice: provider.toolChoiceForTool?.("sum")
      });

      expect(result.toolResults[0]?.toolName).toBe("sum");
      expect(result.text).toContain("5");
    });
  }
});


describeStructuredOutputIntegration("structured output capability integration", () => {
  for (const provider of structuredOutputProviders) {
    it(`${provider.name} returns structured output through the common SDK contract`, async () => {
      const result = await generateObject({
        model: provider.createModel(),
        prompt: "Return a city-country pair for Buenos Aires, Argentina.",
        ...(provider.omitTemperature ? {} : { temperature: provider.temperature ?? 0 }),
        schema: z.object({
          city: z.string(),
          country: z.string()
        }),
        mode: provider.supports.structuredOutputMode
      });

      expect(result.objectMode).toBe(provider.supports.structuredOutputMode);
      expect(result.object.city.toLowerCase()).toContain("buenos");
      expect(result.object.country.toLowerCase()).toContain("argentina");
    });
  }
});
