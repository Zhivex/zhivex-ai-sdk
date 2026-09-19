import assert from "node:assert/strict";
import { createVertex } from "../packages/vertex/src/index.js";
import { vertexIntegrationCredentials } from "../packages/core/tests/vertex-integration-profile.js";

const credentials = vertexIntegrationCredentials(process.env, true);
if (!credentials.configured) throw new Error(credentials.requirement);
const documents = [
  "To reset a forgotten account password, select Forgot password on the login page and follow the link sent to your email.",
  "Bake the bread in a preheated oven at 200 degrees Celsius for thirty minutes, then allow it to cool.",
  "The solar system has eight planets orbiting the Sun, including Earth, Mars and Jupiter."
];
const queries = ["I cannot remember my login secret. How do I regain access?", "Which celestial bodies travel around our star?"];
const expected = [0, 2];
const cosine = (a: number[], b: number[]) => {
  assert.equal(a.length, b.length);
  assert.ok(a.length > 0 && a.every(Number.isFinite) && b.every(Number.isFinite));
  const denominator = Math.hypot(...a) * Math.hypot(...b);
  assert.ok(denominator > 0);
  return a.reduce((sum, value, index) => sum + value * b[index]!, 0) / denominator;
};
const modelIds = ["text-embedding-005", "gemini-embedding-2", "intfloat/multilingual-e5-small-maas", "intfloat/multilingual-e5-large-instruct-maas"];
const selected = process.argv[2];
if (selected && !modelIds.includes(selected)) throw new Error("Select a model from the retrieval smoke matrix.");
for (const modelId of selected ? [selected] : modelIds) {
  try {
    const e5 = modelId === "intfloat/multilingual-e5-small-maas";
    const instruct = modelId === "intfloat/multilingual-e5-large-instruct-maas";
    const legacy = modelId === "text-embedding-005";
    const model = createVertex({ ...credentials.options, location: modelId === "gemini-embedding-2" ? "us" : "us-central1" }).embeddingModel(modelId);
    const bounds = { timeoutMs: 45_000, maxRetries: 0 };
    const docs = await model.embed({ values: documents.map(text => e5 ? `passage: ${text}` : text),
      ...(legacy ? { providerOptions: { taskType: "RETRIEVAL_DOCUMENT" } } : {}), ...bounds });
    const query = await model.embed({ values: queries.map(text => e5 ? `query: ${text}` : instruct ? `Instruct: Retrieve the document that answers the question.\nQuery: ${text}` : text),
      ...(legacy ? { providerOptions: { taskType: "RETRIEVAL_QUERY" } } : {}), ...bounds });
    assert.equal(docs.embeddings.length, documents.length);
    assert.equal(query.embeddings.length, queries.length);
    const rankings = query.embeddings.map((vector, i) => {
      const scores = docs.embeddings.map((doc, index) => ({ index, score: cosine(vector, doc) })).sort((a, b) => b.score - a.score);
      assert.equal(scores[0]!.index, expected[i], `${modelId}: unrelated document ranked first for query ${i}`);
      assert.ok(scores[0]!.score > scores[1]!.score, "Expected a strict ranking, not tied vectors");
      return scores.map(item => ({ ...item, score: Number(item.score.toFixed(4)) }));
    });
    console.log(JSON.stringify({ modelId, verified: true, dimensions: docs.embeddings[0]!.length, rankings }));
  } catch (error) {
    console.log(JSON.stringify({ modelId, verified: false, error: (error as Error).name, status: (error as { status?: number }).status }));
    process.exitCode = 1;
  }
}
