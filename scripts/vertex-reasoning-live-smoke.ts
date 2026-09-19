import assert from "node:assert/strict";
import { createVertex } from "../packages/vertex/src/index.js";
import { vertexIntegrationCredentials } from "../packages/core/tests/vertex-integration-profile.js";

// Explicit invocation: three bounded synthetic scenarios. Never log reasoning text.
const id = process.argv[2];
if (!["google/gemma-4-26b-a4b-it-maas", "deepseek-ai/deepseek-v3.2-maas"].includes(id)) {
  throw new Error("Select the exact Gemma 4 or DeepSeek V3.2 Vertex model ID.");
}
const credentials = vertexIntegrationCredentials(process.env, true);
if (!credentials.configured) throw new Error(credentials.requirement);
const model = createVertex({ ...credentials.options, location: "global" })(id);
const input = {
  messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "What is 17 multiplied by 23? Answer with only the number." }] }],
  maxTokens: 1024, maxRetries: 0, timeoutMs: 45_000
};
const reasoningLength = (data: unknown): number => {
  if (!data || typeof data !== "object") return 0;
  const record = data as Record<string, unknown>;
  return record.type === "reasoning_content" && typeof record.reasoningContent === "string" ? record.reasoningContent.trim().length : 0;
};
let failures = 0;
for (const effort of ["none", "low"] as const) {
  try {
    const result = await model.generate({ ...input, reasoning: { effort } });
    assert.equal(result.text.trim(), "391");
    assert.equal(result.finishReason, "stop");
    const size = result.messages.flatMap(message => message.parts).reduce((total, part) =>
      total + (part.type === "provider-data" && part.provider === "vertex" ? reasoningLength(part.data) : 0), 0);
    assert.equal(size > 0, effort !== "none", "Reasoning toggle did not match returned provider data");
    console.log(JSON.stringify({ modelId: id, scenario: `generate:${effort}`, ok: true, reasoningCharacters: size, usage: result.usage }));
  } catch (error) {
    failures++;
    console.log(JSON.stringify({ modelId: id, scenario: `generate:${effort}`, ok: false, error: (error as Error).name, status: (error as { status?: number }).status }));
  }
}
try {
  let text = "", size = 0, finished = false;
  for await (const event of await model.stream({ ...input, reasoning: { effort: "low" } })) {
    if (event.type === "text-delta") text += event.textDelta;
    if (event.type === "provider-data" && event.provider === "vertex") size += reasoningLength(event.data);
    if (event.type === "finish") { assert.equal(event.finishReason, "stop"); finished = true; }
  }
  assert.equal(text.trim(), "391");
  assert.ok(finished && size > 0, "Missing terminal event or reasoning deltas");
  console.log(JSON.stringify({ modelId: id, scenario: "stream:low", ok: true, reasoningCharacters: size }));
} catch (error) {
  failures++;
  console.log(JSON.stringify({ modelId: id, scenario: "stream:low", ok: false, error: (error as Error).name, status: (error as { status?: number }).status }));
}
process.exitCode = failures ? 1 : 0;
