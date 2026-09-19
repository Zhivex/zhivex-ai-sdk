import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { embedMany, generateObject, generateText, streamText, tool } from "../packages/core/src/index.js";
import { createVertex } from "../packages/vertex/src/index.js";
import { vertexIntegrationCredentials } from "../packages/core/tests/vertex-integration-profile.js";

// Explicit invocation performs eleven bounded, chargeable live scenarios. Never
// print credentials, request headers, provider response bodies or generated text.
// --chat-only runs only the three chat scenarios for the selected model.
// --responses-only runs those scenarios through the Vertex Grok Responses API.
const responsesOnly = process.argv.includes("--responses-only");
const chatOnly = responsesOnly || process.argv.includes("--chat-only");
if (process.argv.slice(2).some(arg => arg !== "--chat-only" && arg !== "--responses-only")) throw new Error("Supported options: --chat-only, --responses-only");
const credentials = vertexIntegrationCredentials(process.env, true);
if (!credentials.configured) throw new Error(credentials.requirement);
const provider = createVertex(credentials.options);
const modelId = process.env.VERTEX_INTEGRATION_MODEL ?? "openai/gpt-oss-120b-maas";
const model = responsesOnly ? provider.responsesModel(modelId) : provider(modelId);
const bounds = { maxRetries: 0, timeoutMs: 30_000, maxTokens: 512 };
let failures = 0;
const check = async (name: string, run: () => Promise<Record<string, unknown>>) => {
  try { console.log(JSON.stringify({ name, api: responsesOnly ? "responses" : "chat", ok: true, ...await run() })); }
  catch (error) {
    failures++;
    const e = error as { name?: string; status?: number; statusCode?: number };
    console.log(JSON.stringify({ name, api: responsesOnly ? "responses" : "chat", ok: false, error: e.name, status: e.status ?? e.statusCode }));
  }
};
await check("chat-stream", async () => {
  const result = streamText({ model, prompt: "Reply exactly OK", ...bounds });
  let text = "";
  for await (const chunk of result.textStream) text += chunk;
  const final = await result.collect();
  assert.ok(text.trim());
  assert.equal(final.finishReason, "stop");
  return { modelId, finishReason: final.finishReason, usage: final.usage };
});
await check("chat-native-schema", async () => {
  const result = await generateObject({ model, prompt: "Return ok=true", schema: z.object({ ok: z.literal(true) }), mode: "native", ...bounds });
  assert.equal(result.object.ok, true);
  return { modelId, mode: result.objectMode };
});
await check("chat-tool-loop", async () => {
  let executions = 0;
  const result = await generateText({ model, prompt: "Call sum with a=2 and b=3, then answer with the numeric result.", ...bounds, maxSteps: 3,
    tools: { sum: tool({ name: "sum", schema: z.object({ a: z.number(), b: z.number() }), execute: ({ a, b }) => { executions++; return { total: a + b }; } }) }
  });
  assert.equal(executions, 1);
  assert.ok(result.text.includes("5"));
  assert.equal(result.finishReason, "stop");
  return { modelId, executions, finishReason: result.finishReason };
});
if (!chatOnly) {
  for (const embeddingModelId of ["text-embedding-005", "gemini-embedding-2", "intfloat/multilingual-e5-small-maas", "intfloat/multilingual-e5-large-instruct-maas"]) {
    await check(`embedding:${embeddingModelId}`, async () => {
      const embeddingProvider = embeddingModelId.startsWith("intfloat/")
        ? createVertex({ ...credentials.options, location: process.env.VERTEX_E5_LOCATION ?? "us-central1" }) : provider;
      const result = await embedMany({ model: embeddingProvider.embeddingModel(embeddingModelId), value: ["query: hello"], maxRetries: 0, timeoutMs: 30_000 });
      assert.equal(result.embeddings.length, 1);
      assert.ok(result.embeddings[0].length > 0);
      assert.ok(result.embeddings[0].every(Number.isFinite));
      return { dimensions: result.embeddings[0].length };
    });
  }
  await check("embedding:legacy-controls", async () => {
    const result = await embedMany({ model: provider.embeddingModel("text-embedding-005"), value: "query: invoice",
      providerOptions: { outputDimensionality: 256, taskType: "RETRIEVAL_QUERY", autoTruncate: false }, maxRetries: 0, timeoutMs: 30_000 });
    assert.equal(result.embeddings.length, 1);
    assert.equal(result.embeddings[0].length, 256);
    assert.ok(result.embeddings[0].every(Number.isFinite));
    return { dimensions: 256 };
  });
  await check("embedding:image-controls", async () => {
    const data = new Uint8Array(readFileSync(new URL("../packages/vertex/tests/fixtures/ocr-invoice.png", import.meta.url)));
    const result = await embedMany({ model: provider.embeddingModel("gemini-embedding-2"), value: { data, mediaType: "image/png" },
      providerOptions: { outputDimensionality: 768 }, maxRetries: 0, timeoutMs: 30_000 });
    assert.equal(result.embeddings.length, 1);
    assert.equal(result.embeddings[0].length, 768);
    assert.ok(result.embeddings[0].every(Number.isFinite));
    return { dimensions: 768 };
  });
  for (const [name, file, mediaType, extra] of [
    ["pdf", "embedding-invoice.pdf", "application/pdf", { documentOcr: true }],
    ["audio", "embedding-tone.wav", "audio/wav", {}]
  ] as const) {
    await check(`embedding:${name}-controls`, async () => {
      const data = new Uint8Array(readFileSync(new URL(`../packages/vertex/tests/fixtures/${file}`, import.meta.url)));
      const result = await embedMany({ model: provider.embeddingModel("gemini-embedding-2"), value: { data, mediaType },
        providerOptions: { outputDimensionality: 768, ...extra }, maxRetries: 0, timeoutMs: 30_000 });
      assert.equal(result.embeddings.length, 1);
      assert.equal(result.embeddings[0].length, 768);
      assert.ok(result.embeddings[0].every(Number.isFinite));
      return { dimensions: 768 };
    });
  }
}
process.exitCode = failures ? 1 : 0;
