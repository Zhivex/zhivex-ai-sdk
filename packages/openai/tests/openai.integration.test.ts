import { describe, expect, it } from "vitest";
import { z } from "zod";

import { embed, generateObject, generateText, streamText, tool } from "@zhivex-ai/core";
import { createOpenAI } from "../src/index.js";

const apiKey = process.env.OPENAI_API_KEY;
const baseURL = process.env.OPENAI_BASE_URL;
const textModelId = process.env.OPENAI_INTEGRATION_MODEL ?? "gpt-5.4-nano";
const embeddingModelId = process.env.OPENAI_INTEGRATION_EMBEDDING_MODEL ?? "text-embedding-3-small";

const describeIntegration = apiKey ? describe.sequential : describe.skip;

describeIntegration("openai adapter integration", () => {
  const provider = () =>
    createOpenAI({
      apiKey,
      baseURL
    });

  it("generates text against the real OpenAI API", async () => {
    const result = await generateText({
      model: provider()(textModelId),
      prompt: "Reply with exactly: integration-openai-ok",
      temperature: 0,
      maxTokens: 32
    });

    expect(result.text.toLowerCase()).toContain("integration-openai-ok");
    expect(result.finishReason).toBeDefined();
    expect(result.usage?.totalTokens).toBeGreaterThan(0);
  });

  it("streams text against the real OpenAI API", async () => {
    const result = streamText({
      model: provider()(textModelId),
      prompt: "Reply with exactly: integration-openai-stream-ok",
      temperature: 0,
      maxTokens: 32
    });

    const chunks: string[] = [];
    for await (const chunk of result.textStream) {
      chunks.push(chunk);
    }

    const final = await result.collect();
    expect(chunks.join("")).not.toHaveLength(0);
    expect(final.text.toLowerCase()).toContain("integration-openai-stream-ok");
    expect(final.finishReason).toBeDefined();
  });

  it("runs a real tool loop against the OpenAI API", async () => {
    const result = await generateText({
      model: provider()(textModelId),
      prompt: "Call the sum tool with a=2 and b=3, then answer with only the numeric result.",
      temperature: 0,
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
      toolChoice: {
        type: "tool",
        toolName: "sum"
      }
    });

    expect(result.toolResults[0]?.toolName).toBe("sum");
    expect(result.text).toContain("5");
  });

  it("produces native structured output against the real OpenAI API", async () => {
    const result = await generateObject({
      model: provider()(textModelId),
      prompt: "Return a city-country pair for Buenos Aires, Argentina.",
      temperature: 0,
      schema: z.object({
        city: z.string(),
        country: z.string()
      }),
      mode: "native"
    });

    expect(result.objectMode).toBe("native");
    expect(result.object.city.toLowerCase()).toContain("buenos");
    expect(result.object.country.toLowerCase()).toContain("argentina");
  });

  it("embeds text against the real OpenAI API", async () => {
    const result = await embed({
      model: provider().embeddingModel(embeddingModelId),
      value: "OpenAI integration test vector"
    });

    expect(result.embeddings).toHaveLength(1);
    expect(result.embeddings[0]?.length ?? 0).toBeGreaterThan(0);
    expect(result.usage?.totalTokens ?? result.usage?.inputTokens ?? 0).toBeGreaterThan(0);
  });
});
