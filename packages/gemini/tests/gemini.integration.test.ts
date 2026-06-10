import { describe, expect, it } from "vitest";
import { z } from "zod";

import { embed, generateObject, generateText, streamText, tool } from "@zhivex-ai/core";
import { createGemini } from "../src/index.js";

const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
const baseURL = process.env.GEMINI_BASE_URL;
const textModelId = process.env.GEMINI_INTEGRATION_MODEL ?? "gemini-3.1-flash-lite";
const embeddingModelId = process.env.GEMINI_INTEGRATION_EMBEDDING_MODEL ?? "gemini-embedding-001";

const describeIntegration = apiKey ? describe.sequential : describe.skip;

describeIntegration("gemini adapter integration", () => {
  const provider = () =>
    createGemini({
      apiKey,
      baseURL
    });

  it("generates text against the real Gemini API", async () => {
    const result = await generateText({
      model: provider()(textModelId),
      prompt: "Reply with exactly: integration-gemini-ok",
      temperature: 0,
      maxTokens: 128
    });

    expect(result.text.toLowerCase()).toContain("integration-gemini-ok");
    expect(result.finishReason).toBeDefined();
  });

  it("streams text against the real Gemini API", async () => {
    const result = streamText({
      model: provider()(textModelId),
      prompt: "Reply with exactly: integration-gemini-stream-ok",
      temperature: 0,
      maxTokens: 128
    });

    const chunks: string[] = [];
    for await (const chunk of result.textStream) {
      chunks.push(chunk);
    }

    const final = await result.collect();
    expect(chunks.join("")).not.toHaveLength(0);
    expect(final.text.toLowerCase()).toContain("integration-gemini-stream-ok");
    expect(final.finishReason).toBeDefined();
  });

  it("runs a real tool loop against the Gemini API", async () => {
    const result = await generateText({
      model: provider()(textModelId),
      prompt: "Call the sum tool with a=2 and b=3, then answer with only the numeric result.",
      temperature: 0,
      maxTokens: 128,
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

  it("produces native structured output against the real Gemini API", async () => {
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

  it("embeds text against the real Gemini API", async () => {
    const result = await embed({
      model: provider().embeddingModel(embeddingModelId),
      value: "Gemini integration test vector"
    });

    expect(result.embeddings).toHaveLength(1);
    expect(result.embeddings[0]?.length ?? 0).toBeGreaterThan(0);
  });
});
