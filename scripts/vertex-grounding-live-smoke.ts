import assert from "node:assert/strict";
import { createVertex } from "../packages/vertex/src/index.js";
import { vertexIntegrationCredentials } from "../packages/core/tests/vertex-integration-profile.js";
const credentials = vertexIntegrationCredentials(process.env, true);
if (!credentials.configured) throw new Error(credentials.requirement);
try {
  const result = await createVertex({ ...credentials.options, location: "global" }).groundedLanguageModel!("gemini-3.7-flash").generate({
    messages: [{ role: "user", parts: [{ type: "text", text: "Search Google for the official Google Cloud documentation for Vertex AI multimodal embeddings. Give its documentation title and a brief description with sources." }] }],
    maxTokens: 1024, timeoutMs: 45_000, maxRetries: 0
  });
  assert.ok(result.text.trim());
  assert.ok(result.sources.length > 0, "Expected grounding sources");
  for (const source of result.sources) assert.ok(new URL(source.url).protocol === "https:");
  assert.ok((result.usage?.inputTokens ?? 0) > 0);
  assert.ok((result.usage?.outputTokens ?? 0) > 0);
  const raw = result.rawResponse as { candidates?: Array<{groundingMetadata?: { groundingSupports?: unknown[] }}> };
  assert.ok(raw.candidates?.[0]?.groundingMetadata?.groundingSupports?.length, "Expected attribution supports in raw metadata");
  console.log(JSON.stringify({ ok: true, sources: result.sources.length, inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens, attributionSupports: true }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: (error as Error).name, status: (error as {status?:number}).status }));
  process.exitCode = 1;
}
