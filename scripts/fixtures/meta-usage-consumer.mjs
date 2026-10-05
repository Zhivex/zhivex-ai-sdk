import assert from "node:assert/strict";
import { generateText, streamText } from "@zhivex-ai/core";
import { createMeta } from "@zhivex-ai/meta";

const text = "installed Meta usage fixture";
for (const reasoningTokens of [790, 0, undefined]) {
  const usage = { input_tokens: 1679, output_tokens: 830, total_tokens: 2509,
    ...(reasoningTokens === undefined ? {} : { output_tokens_details: { reasoning_tokens: reasoningTokens } }) };
  const body = { id: "resp_installed_usage", status: "completed", usage,
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] };
  let calls = 0;
  const provider = createMeta({ apiKey: "offline-installed-usage", fetch: async (_url, init) => {
    calls++;
    if (!JSON.parse(init.body).stream) return Response.json(body);
    const events = [{ type: "response.output_text.delta", delta: text }, { type: "response.completed", response: body }];
    return new Response(events.map(event => "data: " + JSON.stringify(event) + "\n\n").join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  const model = provider("muse-spark-1.3-contributor");
  const input = { model, prompt: "offline fixture", providerOptions: { apiMode: "responses" }, maxRetries: 0 };
  const results = [await generateText(input), await streamText(input).collect(),
    await provider.groundedLanguageModel("muse-spark-1.3-contributor").generate({ prompt: "offline fixture", maxRetries: 0 })];
  for (const result of results) {
    assert.equal(result.text, text);
    assert.equal(result.usage.inputTokens, 1679);
    assert.equal(result.usage.outputTokens, 830);
    assert.equal(result.usage.totalTokens, 2509);
    assert.equal(result.usage.reasoningTokens, reasoningTokens);
  }
  assert.equal(calls, 3);
}
console.log("INSTALLED_META_REASONING_USAGE_OK");
