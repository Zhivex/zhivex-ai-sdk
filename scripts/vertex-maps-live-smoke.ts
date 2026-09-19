import assert from "node:assert/strict";
import { googleMapsTool } from "../packages/core/src/index.js";
import { createVertex } from "../packages/vertex/src/index.js";
import { vertexIntegrationCredentials } from "../packages/core/tests/vertex-integration-profile.js";
const credentials = vertexIntegrationCredentials(process.env, true);
if (!credentials.configured) throw new Error(credentials.requirement);
try {
  const result = await createVertex({ ...credentials.options, location: "global" })("gemini-3.7-flash").generate({
    messages: [{ role: "user", parts: [{ type: "text", text: "Use Google Maps to find two public museums near these coordinates in Manhattan. Give their names and addresses, with sources." }] }],
    tools: { maps: googleMapsTool({ latitude: 40.7794, longitude: -73.9632, enableWidget: false }) },
    maxTokens: 1024, timeoutMs: 45_000, maxRetries: 0
  });
  assert.ok(result.text.trim());
  const raw = result.rawResponse as { candidates?: Array<{ groundingMetadata?: { groundingChunks?: Array<{maps?:{uri?:string;title?:string}}>; groundingSupports?: unknown[] } }> };
  const metadata = raw.candidates?.[0]?.groundingMetadata;
  const places = metadata?.groundingChunks?.flatMap(chunk => chunk.maps ? [chunk.maps] : []) ?? [];
  assert.ok(places.length > 0, "Expected Maps grounding chunks");
  assert.ok(places.every(place => place.title && place.uri && new URL(place.uri).protocol === "https:"));
  assert.ok(metadata?.groundingSupports?.length, "Expected Maps attribution supports");
  assert.ok((result.usage?.inputTokens ?? 0) > 0);
  console.log(JSON.stringify({ ok: true, places: places.length, attributionSupports: metadata.groundingSupports.length, usage: result.usage }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: (error as Error).name, status: (error as {status?:number}).status }));
  process.exitCode = 1;
}
