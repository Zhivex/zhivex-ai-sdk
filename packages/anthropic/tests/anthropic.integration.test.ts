import { describe, expect, it } from "vitest";
import { z } from "zod";

import { generateObject, generateText, streamText, tool } from "@zhivex-ai/core";
import { createAnthropic } from "../src/index.js";

const apiKey = process.env.ANTHROPIC_API_KEY;
const baseURL = process.env.ANTHROPIC_BASE_URL;
const anthropicVersion = process.env.ANTHROPIC_VERSION;
const textModelId = process.env.ANTHROPIC_INTEGRATION_MODEL ?? "claude-3-5-sonnet";
const usesModernAnthropicControls = (modelId: string) =>
  /^(?:claude-opus-4-(?:7|8|9)|claude-opus-[5-9]|claude-(?:sonnet|fable|mythos)-5)(?:[-@]|$)/.test(modelId);
const anthropicTemperature = usesModernAnthropicControls(textModelId) ? undefined : 0;

const describeIntegration = apiKey ? describe.sequential : describe.skip;

describeIntegration("anthropic adapter integration", () => {
  const provider = () =>
    createAnthropic({
      apiKey,
      baseURL,
      anthropicVersion
    });

  it("generates text against the real Anthropic API", async () => {
    const result = await generateText({
      model: provider()(textModelId),
      prompt: "Reply with exactly: integration-anthropic-ok",
      temperature: anthropicTemperature,
      maxTokens: 32
    });

    expect(result.text.toLowerCase()).toContain("integration-anthropic-ok");
    expect(result.finishReason).toBeDefined();
    expect(result.usage?.totalTokens).toBeGreaterThan(0);
  });

  it("streams text against the real Anthropic API", async () => {
    const result = streamText({
      model: provider()(textModelId),
      prompt: "Reply with exactly: integration-anthropic-stream-ok",
      temperature: anthropicTemperature,
      maxTokens: 32
    });

    const chunks: string[] = [];
    for await (const chunk of result.textStream) {
      chunks.push(chunk);
    }

    const final = await result.collect();
    expect(chunks.join("")).not.toHaveLength(0);
    expect(final.text.toLowerCase()).toContain("integration-anthropic-stream-ok");
    expect(final.finishReason).toBeDefined();
  });

  it("runs a real tool loop against the Anthropic API", async () => {
    const result = await generateText({
      model: provider()(textModelId),
      prompt: "Call the sum tool with a=2 and b=3, then answer with only the numeric result.",
      temperature: anthropicTemperature,
      maxTokens: 32,
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
      toolChoice: "required"
    });

    expect(result.toolResults[0]?.toolName).toBe("sum");
    expect(result.text).toContain("5");
  });

  it("produces prompted structured output against the real Anthropic API", async () => {
    const result = await generateObject({
      model: provider()(textModelId),
      prompt: "Return a city-country pair for Buenos Aires, Argentina.",
      temperature: anthropicTemperature,
      schema: z.object({
        city: z.string(),
        country: z.string()
      }),
      mode: "prompted"
    });

    expect(result.objectMode).toBe("prompted");
    expect(result.object.city.toLowerCase()).toContain("buenos");
    expect(result.object.country.toLowerCase()).toContain("argentina");
  });
});
