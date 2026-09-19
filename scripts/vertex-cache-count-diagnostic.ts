import assert from "node:assert/strict";
import { createVertex } from "../packages/vertex/src/index.js";
import { vertexIntegrationCredentials } from "../packages/core/tests/vertex-integration-profile.js";
const credentials = vertexIntegrationCredentials(process.env, true);
if (!credentials.configured) throw new Error(credentials.requirement);
const text = Array.from({ length: 300 }, (_, i) => `Record ${i}: This synthetic inventory contains blue boxes and green labels for cache validation.`).join("\n");
try {
  const result = await createVertex({ ...credentials.options, location: "us-central1" }).gemini.countTokens({
    modelId: "gemini-2.5-flash", messages: [{ role: "user", parts: [{ type: "text", text }] }], timeoutMs: 30_000, maxRetries: 0
  });
  assert.ok(result.inputTokens > 1024);
  console.log(JSON.stringify({ ok: true, textCharacters: text.length, totalTokens: result.inputTokens, cacheCreated: false }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: (error as Error).name, status: (error as {status?:number}).status }));
  process.exitCode = 1;
}
