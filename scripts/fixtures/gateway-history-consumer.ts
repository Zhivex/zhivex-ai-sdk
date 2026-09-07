// Copied into the isolated tarball consumer; all imports resolve to installed packages.
import assert from "node:assert/strict";
import { createGateway, type GatewayRequest, type GatewayMessage, type GatewayProviderId } from "@zhivex-ai/gateway";
import { createAnthropic } from "@zhivex-ai/anthropic";
import { createOpenAI } from "@zhivex-ai/openai";
import { createDeepSeek } from "@zhivex-ai/deepseek";
import { createQwen } from "@zhivex-ai/qwen";
import { tool, type ModelMessage } from "@zhivex-ai/core";
import { z } from "zod";
import type { ModelCapabilities, ModelGenerateInput } from "@zhivex-ai/sdk";

const live = process.argv.includes("--live");
const provider = process.argv.find((arg) => arg.startsWith("--provider="))?.split("=")[1] ?? "anthropic";
const api = process.argv.find((arg) => arg.startsWith("--api="))?.split("=")[1];
const entries = [
  { provider: "anthropic", model: "claude-sonnet-4-6", mode: "messages", factory: createAnthropic },
  { provider: "openai", model: "gpt-4.1", mode: "chat", factory: createOpenAI },
  { provider: "openai", model: "gpt-4.1", mode: "responses", factory: createOpenAI },
  { provider: "deepseek", model: "deepseek-chat", mode: "chat", factory: createDeepSeek },
  { provider: "qwen", model: "qwen-plus", mode: "chat", factory: createQwen },
  { provider: "qwen", model: "qwen-plus", mode: "responses", factory: createQwen }
] as const;
const selected = live ? entries.filter((entry) => entry.provider === provider && (!api || entry.mode === api)).slice(0, 1) : entries;
const capabilities: Pick<ModelCapabilities, "toolHistory"> = { toolHistory: "json" };
const input: Pick<ModelGenerateInput, "toolResultFormat"> = { toolResultFormat: "envelope" };
void capabilities; void input;
const evidence = [];
for (const entry of selected) {
  let calls = 0;
  let executions = 0;
  let httpStatus: number | undefined;
  let operation = "generate";
  const bodies: Record<string, any>[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    if (live) { const response = await fetch(url, init); httpStatus = response.status; return response; }
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (entry.mode === "messages") {
      if (!body.stream) return Response.json({ content: [{ type: "text", text: "18 C" }], stop_reason: "end_turn", usage: { input_tokens: 40, output_tokens: 5 } });
      return new Response('event: message_start\ndata: {"message":{"usage":{"input_tokens":40}}}\n\n' +
        'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"18 C"}}\n\n' +
        'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n' +
        'event: message_stop\ndata: {}\n\n', { headers: { "content-type": "text/event-stream" } });
    }
    if (entry.mode === "responses") {
      const response = { id: "resp_1", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "18 C" }] }], usage: { input_tokens: 40, output_tokens: 5, total_tokens: 45 } };
      return body.stream ? new Response('data: {"type":"response.output_text.delta","delta":"18 C"}\n\ndata: ' + JSON.stringify({ type: "response.completed", response }) + '\n\n', { headers: { "content-type": "text/event-stream" } }) : Response.json(response);
    }
    const usage = { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 };
    return body.stream ? new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: "18 C" }, finish_reason: "stop" }], usage }) + '\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }) : Response.json({ choices: [{ message: { content: "18 C" }, finish_reason: "stop" }], usage });
  };
  const adapter = entry.factory(live ? { fetch: fetcher } : { apiKey: "test", fetch: fetcher });
  const gateway = createGateway({ adapters: { [entry.provider]: adapter }, maxRetries: 0, maxTotalAttempts: 2, attemptTimeoutMs: 30000 });
  const messages: ModelMessage[] = [
    { role: "user", parts: [{ type: "text", text: "What is the temperature in Buenos Aires? Use the supplied weather result and mention its numeric value." }] },
    { role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "call_weather_1", name: "weather", input: { city: "Buenos Aires" } } }] },
    { role: "tool", parts: [{ type: "tool-result", toolResult: { toolCallId: "call_weather_1", toolName: "weather", output: { temperatureC: 18 }, isError: false } }] }
  ];
  const request: GatewayRequest = {
    primary: { provider: entry.provider as GatewayProviderId, modelId: live ? process.env.ZHIVEX_GATEWAY_HISTORY_MODEL ?? entry.model : entry.model }, messages,
    tools: { weather: tool({ name: "weather", description: "Current temperature", schema: z.object({ city: z.string() }), execute: async () => { executions++; return { temperatureC: 0 }; } }) },
    toolChoice: "none", maxSteps: 1, ...(entry.mode === "responses" ? {} : { maxTokens: 100 }),
    providerOptions: entry.provider === "qwen" || entry.provider === "openai" ? { apiMode: entry.mode } : {},
    abortSignal: AbortSignal.timeout(45000)
  };
  const legacy: GatewayMessage[] = [{ role: "user", content: "hello" }];
  const compatible: GatewayRequest = { ...request, messages: legacy }; void compatible;
  try {
    const generated = await gateway.generate(request);
    operation = "stream";
    const streamed = await gateway.streamText(request).collect();
    for (const result of [generated, streamed]) {
      assert.match(result.text, /18/);
      assert.equal(result.finishReason, "stop");
      assert.equal(result.attempts.length, 1);
      assert.equal(result.attempts[0]?.ok, true);
      assert.ok((result.usage.totalTokens ?? 0) > 0);
      assert.equal(result.usage.estimated, false);
    }
    assert.equal(calls, 2); assert.equal(executions, 0);
    if (!live) {
      assert.deepEqual(bodies[0]!.messages ?? bodies[0]!.input, bodies[1]!.messages ?? bodies[1]!.input);
      if (entry.mode === "chat") assert.deepEqual(JSON.parse(bodies[0]!.messages.at(-1).content), { output: { temperatureC: 18 } });
      if (entry.mode === "responses") assert.deepEqual(JSON.parse(bodies[0]!.input.at(-1).output), { output: { temperatureC: 18 } });
    }
    evidence.push({ provider: entry.provider, api: entry.mode, calls, executions, model: request.primary.modelId, generate: { usage: generated.usage, finishReason: generated.finishReason }, stream: { usage: streamed.usage, finishReason: streamed.finishReason } });
  } catch {
    console.log(JSON.stringify({ status: "failed", provider: entry.provider, operation, calls, httpStatus }));
    process.exit(1);
  }
}
assert.ok(selected.length);
console.log(JSON.stringify({ status: "passed", mode: live ? "live" : "mock", providers: evidence }));
