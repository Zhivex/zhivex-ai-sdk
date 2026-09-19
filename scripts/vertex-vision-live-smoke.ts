import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { generateObject, streamText } from "../packages/core/src/index.js";
import { createVertex } from "../packages/vertex/src/index.js";
import { vertexIntegrationCredentials } from "../packages/core/tests/vertex-integration-profile.js";

// Explicit invocation: two bounded calls, repository-owned synthetic invoice only.
const responses = process.argv.includes("--responses");
if (process.argv.slice(2).some(arg => arg !== "--responses")) throw new Error("Supported option: --responses");
const credentials = vertexIntegrationCredentials(process.env, true);
if (!credentials.configured) throw new Error(credentials.requirement);
const modelId = process.env.VERTEX_INTEGRATION_MODEL ?? (responses ? "xai/grok-4.20-reasoning" : "google/gemma-4-26b-a4b-it-maas");
const provider = createVertex({ ...credentials.options, location: "global" });
const model = responses ? provider.responsesModel(modelId) : provider(modelId);
if (!model.capabilities.vision || !model.capabilities.structuredOutput) throw new Error("The vision smoke requires vision and native schema capabilities.");
const api = responses ? "responses" : "chat";
const image = (await readFile(new URL("../packages/vertex/tests/fixtures/ocr-invoice.png", import.meta.url))).toString("base64");
const messages = [{ role: "user" as const, parts: [
  { type: "text" as const, text: "Read the invoice image and extract its total amount and currency." },
  { type: "image" as const, image, mediaType: "image/png" }
] }];
const bounds = { maxTokens: responses ? 1024 : 256, timeoutMs: 30_000, maxRetries: 0 };
let failures = 0;
try {
  const result = await generateObject({ model, messages, schema: z.object({ amount: z.number(), currency: z.string() }), mode: "native", ...bounds });
  assert.equal(result.object.amount, 42);
  assert.equal(result.object.currency, "USD");
  assert.equal(result.objectMode, "native");
  console.log(JSON.stringify({ modelId, api, scenario: "vision-native-schema", ok: true, usage: result.usage }));
} catch (error) {
  failures++;
  console.log(JSON.stringify({ modelId, api, scenario: "vision-native-schema", ok: false, error: (error as Error).name, status: (error as {status?: number}).status }));
}
try {
  const result = streamText({ model, messages, ...bounds });
  let text = "";
  for await (const chunk of result.textStream) text += chunk;
  const final = await result.collect();
  assert.match(text, /\b42(?:\.00)?\b/);
  assert.match(text, /USD|US dollars|U\.S\. dollars/i);
  assert.equal(final.finishReason, "stop");
  console.log(JSON.stringify({ modelId, api, scenario: "vision-stream", ok: true, usage: final.usage }));
} catch (error) {
  failures++;
  console.log(JSON.stringify({ modelId, api, scenario: "vision-stream", ok: false, error: (error as Error).name, status: (error as {status?: number}).status }));
}
process.exitCode = failures ? 1 : 0;
