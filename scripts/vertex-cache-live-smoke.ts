import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createVertex } from "../packages/vertex/src/index.js";
import { vertexIntegrationCredentials } from "../packages/core/tests/vertex-integration-profile.js";
const credentials = vertexIntegrationCredentials(process.env, true);
if (!credentials.configured) throw new Error(credentials.requirement);
let sentTextCharacters = 0;
const useGcs = process.argv.includes("--gcs");
const diverseText = process.argv.includes("--diverse-text");
if (useGcs && diverseText) throw new Error("Select one cache fixture.");
const publicPdf = "gs://cloud-samples-data/generative-ai/pdf/2403.05530.pdf";
const provider = createVertex({ ...credentials.options, location: "us-central1", fetch: async (url, init) => {
  if (init?.method === "POST" && String(url).endsWith("/cachedContents")) {
    const body = JSON.parse(String(init.body));
    sentTextCharacters = (body.contents ?? []).flatMap((content: {parts?:Array<{text?:string}>}) => content.parts ?? []).reduce((sum: number, part: {text?:string}) => sum + (part.text?.length ?? 0), 0);
    if (useGcs) assert.ok(body.contents.some((content: { parts: Array<{ fileData?: { fileUri: string } }> }) => content.parts.some(part => part.fileData?.fileUri === publicPdf)), "Public PDF must reach the HTTP transport intact");
    else assert.ok(sentTextCharacters > 20_000, "Cache fixture must reach the HTTP transport intact");
  }
  return globalThis.fetch(url, init);
} });
const marker = randomUUID();
const statePath = `/tmp/vertex-cache-${marker}.json`;
let name: string | undefined;
let verified = false, cleaned = false;
let cachedInputTokens: number | undefined;
let updated = false;
let ttlUpdated = false;
const save = () => writeFile(statePath, JSON.stringify({ name, displayName: `zhivex-smoke-${marker}`, fixture: useGcs ? "public-gcs-pdf" : diverseText ? "diverse-text" : "text", verified, updated, ttlUpdated, cleaned, sentTextCharacters }), { mode: 0o600 });
try {
  const contents = `The verification code is ${marker}.\n` + Array.from({ length: 300 }, (_, i) => diverseText
    ? `Inventory ${i}: shipment ${randomUUID()} contains ${i * 7 + 13} units, warehouse ${i % 17}, inspection ${randomUUID()}, measured weight ${(i * 1.37).toFixed(2)} kg.`
    : `Record ${i}: This synthetic inventory contains blue boxes and green labels for cache validation.`).join("\n");
  const cache = await provider.caches!.create({ modelId: "gemini-2.5-flash", displayName: `zhivex-smoke-${marker}`, ttl: "120s",
    contents: [{ role: "user", parts: useGcs ? [{ type: "text", text: `The verification code is ${marker}.` }, { type: "file", data: publicPdf, mediaType: "application/pdf" }] : [{ type: "text", text: contents }] }], timeoutMs: 60_000, maxRetries: 0 });
  name = cache.name;
  await save();
  assert.equal((await provider.caches!.get({ name, timeoutMs: 15_000, maxRetries: 0 })).name, name);
  const expiry = new Date(Date.now() + 120_000).toISOString();
  const update = await provider.caches.update({ name, expireTime: expiry, timeoutMs: 15_000, maxRetries: 0 });
  assert.equal(Date.parse(update.expireTime!), Date.parse(expiry), "Cache expiration update was not applied");
  updated = true;
  await save();
  const ttlStart = Date.now();
  const ttlUpdate = await provider.caches.update({ name, ttl: "120s", timeoutMs: 15_000, maxRetries: 0 });
  const ttlExpiry = Date.parse(ttlUpdate.expireTime!);
  assert.ok(ttlExpiry >= ttlStart + 110_000 && ttlExpiry <= Date.now() + 130_000, "TTL update did not return the expected expiration");
  ttlUpdated = true;
  await save();
  const result = await provider("gemini-2.5-flash").generate({ messages: [{ role: "user", parts: [{ type: "text", text: "What is the verification code in the cached inventory? Reply only with that code." }] }],
    providerOptions: { cachedContent: name }, reasoning: { budgetTokens: 0 }, maxTokens: 128, timeoutMs: 30_000, maxRetries: 0 });
  assert.ok(result.text.includes(marker), "Cached verification code was not recovered");
  cachedInputTokens = result.usage?.cachedInputTokens;
  assert.ok((cachedInputTokens ?? 0) > 0, "Expected nonzero cached input token usage");
  verified = true;
} catch (error) {
  if (process.env.VERTEX_LIVE_DIAGNOSTICS === "1") console.error(JSON.stringify((error as { responseBody?: unknown }).responseBody));
  console.log(JSON.stringify({ ok: false, error: (error as Error).name, status: (error as { status?: number }).status, created: !!name, sentTextCharacters }));
  process.exitCode = 1;
} finally {
  if (name) {
    try {
      await provider.caches!.delete({ name, timeoutMs: 15_000, maxRetries: 0 });
      await assert.rejects(provider.caches!.get({ name, timeoutMs: 15_000, maxRetries: 0 }), (error: unknown) => (error as {status?:number}).status === 404);
      cleaned = true;
    } catch (error) {
      console.log(JSON.stringify({ cleanupFailed: true, error: (error as Error).name, statePath }));
      process.exitCode = 1;
    }
  }
  await save();
  console.log(JSON.stringify({ verified, cleaned, cachedInputTokens, statePath }));
}
