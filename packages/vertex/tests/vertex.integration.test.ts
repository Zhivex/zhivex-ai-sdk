import { describe, expect, it } from "vitest";
import { z } from "zod";

import { embed, generateObject, generateText, streamText, tool } from "@zhivex-ai/core";
import { createVertex } from "../src/index.js";

const accessToken = process.env.VERTEX_ACCESS_TOKEN ?? process.env.GOOGLE_ACCESS_TOKEN;
const apiKey = process.env.VERTEX_API_KEY ?? process.env.GOOGLE_API_KEY;
const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
const location = process.env.VERTEX_LOCATION ?? process.env.GOOGLE_CLOUD_LOCATION;
const baseURL = process.env.VERTEX_BASE_URL;
const textModelId = process.env.VERTEX_INTEGRATION_MODEL ?? "gemini-3.5-flash";
const embeddingModelId = process.env.VERTEX_INTEGRATION_EMBEDDING_MODEL ?? "text-embedding-005";
const usableAccessToken = accessToken && (projectId || baseURL) ? accessToken : undefined;

const hasVertexCredentials = Boolean(usableAccessToken || apiKey);
const describeIntegration = hasVertexCredentials ? (describe.sequential ?? describe.skip) : describe.skip;

describeIntegration("vertex adapter integration", () => {
  const provider = () =>
    createVertex({
      accessToken: usableAccessToken,
      apiKey,
      projectId,
      location,
      baseURL
    });

  it("generates text against the real Vertex API", async () => {
    const result = await generateText({
      model: provider()(textModelId),
      prompt: "Reply with exactly: integration-vertex-ok",
      temperature: 0,
      maxTokens: 32
    });

    expect(result.text.toLowerCase()).toContain("integration-vertex-ok");
    expect(result.finishReason).toBeDefined();
  });

  it("streams text against the real Vertex API", async () => {
    const result = streamText({
      model: provider()(textModelId),
      prompt: "Reply with exactly: integration-vertex-stream-ok",
      temperature: 0,
      maxTokens: 32
    });

    const chunks: string[] = [];
    for await (const chunk of result.textStream) {
      chunks.push(chunk);
    }

    const final = await result.collect();
    expect(chunks.join("")).not.toHaveLength(0);
    expect(final.text.toLowerCase()).toContain("integration-vertex-stream-ok");
    expect(final.finishReason).toBeDefined();
  });

  it("runs a real tool loop against the Vertex API", async () => {
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

  it("produces native structured output against the real Vertex API", async () => {
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

  it("embeds text against the real Vertex API", async () => {
    const result = await embed({
      model: provider().embeddingModel(embeddingModelId),
      value: "Vertex integration test vector"
    });

    expect(result.embeddings).toHaveLength(1);
    expect(result.embeddings[0]?.length ?? 0).toBeGreaterThan(0);
  });
});
