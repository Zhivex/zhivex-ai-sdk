import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createVertex } from "../packages/vertex/src/index.js";
import { vertexIntegrationCredentials } from "../packages/core/tests/vertex-integration-profile.js";

const credentials = vertexIntegrationCredentials(process.env, true);
if (!credentials.configured) throw new Error(credentials.requirement);
const image = { data: await readFile(new URL("../packages/vertex/tests/fixtures/ocr-invoice.png", import.meta.url)), mediaType: "image/png" };
const descriptions = ["A document showing an invoice total of 42 US dollars.", "A photograph of a forest with tall trees.", "An illustration of planets orbiting the sun."];
for (const modelId of ["gemini-embedding-2", "multimodalembedding@001"]) {
  try {
    const model = createVertex({ ...credentials.options, location: modelId === "gemini-embedding-2" ? "us" : "us-central1" }).embeddingModel(modelId);
    const result = await model.embed({ values: [image, ...descriptions], providerOptions: { outputDimensionality: 128 }, timeoutMs: 45_000, maxRetries: 0 });
    assert.equal(result.embeddings.length, 4);
    for (const vector of result.embeddings) {
      assert.equal(vector.length, 128);
      assert.ok(vector.every(Number.isFinite) && Math.hypot(...vector) > 0);
    }
    const query = result.embeddings[0]!;
    const ranking = result.embeddings.slice(1).map((vector, index) => ({ index,
      score: vector.reduce((sum, value, i) => sum + value * query[i]!, 0) / (Math.hypot(...vector) * Math.hypot(...query))
    })).sort((a, b) => b.score - a.score);
    assert.equal(ranking[0]!.index, 0, "Invoice description did not rank first for the image");
    assert.ok(ranking[0]!.score > ranking[1]!.score, "Expected a strict cross-modal ranking");
    console.log(JSON.stringify({ modelId, verified: true, dimensions: 128, ranking: ranking.map(item => ({ ...item, score: Number(item.score.toFixed(4)) })) }));
  } catch (error) {
    console.log(JSON.stringify({ modelId, verified: false, error: (error as Error).name, status: (error as {status?:number}).status }));
    process.exitCode = 1;
  }
}
