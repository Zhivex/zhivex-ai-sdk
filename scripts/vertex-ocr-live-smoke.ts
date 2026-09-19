import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createVertex } from "../packages/vertex/src/index.js";
import { vertexIntegrationCredentials } from "../packages/core/tests/vertex-integration-profile.js";

// Two explicitly invoked, bounded billable requests against a synthetic image.
// A successful HTTP response is insufficient: verify all fixture text.
const credentials = vertexIntegrationCredentials(process.env, true);
if (!credentials.configured) throw new Error(credentials.requirement);
const document = { data: new Uint8Array(readFileSync(new URL("../packages/vertex/tests/fixtures/ocr-invoice.png", import.meta.url))), mediaType: "image/png" };
let failures = 0;
const selected = process.argv[2];
if (selected && !["deepseek-ai/deepseek-ocr-maas", "mistralai/mistral-ocr-2505"].includes(selected)) throw new Error("Unknown OCR smoke model.");
for (const [modelId, location] of [
  ["deepseek-ai/deepseek-ocr-maas", process.env.VERTEX_OCR_LOCATION ?? "global"],
  ["mistralai/mistral-ocr-2505", process.env.VERTEX_MISTRAL_LOCATION ?? "us-central1"]
]) {
  if (selected && selected !== modelId) continue;
  try {
    const result = await createVertex({ ...credentials.options, location }).ocr.process({
      modelId, document, maxRetries: 0, timeoutMs: 45_000,
      ...(modelId.startsWith("deepseek-ai/") ? { prompt: process.env.VERTEX_OCR_PROMPT, providerOptions: { temperature: 0, max_tokens: 256 } } : {})
    });
    assert.equal(result.pages.length, 1);
    if (process.env.VERTEX_LIVE_DIAGNOSTICS === "1") {
      // This fixture is repository-owned synthetic text, never a user document.
      console.log(JSON.stringify({ modelId, syntheticFixtureText: result.text.slice(0, 512) }));
    }
    assert.match(result.text, /Invoice\s+total:\s*42\s+USD/i, "OCR omitted or changed synthetic fixture text");
    console.log(JSON.stringify({ modelId, location, ok: true, pages: result.pages.length }));
  } catch (error) {
    failures++;
    const e = error as { name?: string; status?: number; statusCode?: number; responseBody?: unknown };
    if (process.env.VERTEX_LIVE_DIAGNOSTICS === "1" && e.responseBody !== undefined) {
      let body = e.responseBody;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { /* Some providers return a plain-text error body. */ } }
      const item = (Array.isArray(body) ? body[0] : body) as { error?: { message?: unknown } | string; message?: unknown; detail?: unknown } | undefined;
      const message = typeof body === "string" ? body : typeof item?.error === "string" ? item.error : item?.error?.message ?? item?.message ?? item?.detail;
      if (typeof message === "string") console.log(JSON.stringify({ modelId, syntheticFixtureError: message.slice(0, 512).replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]") }));
    }
    console.log(JSON.stringify({ modelId, location, ok: false, error: e.name, status: e.status ?? e.statusCode }));
  }
}
process.exitCode = failures ? 1 : 0;
