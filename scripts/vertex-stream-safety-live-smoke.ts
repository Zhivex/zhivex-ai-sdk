// Copy into an installed-package consumer. Run with Bun and an explicit env file.
// Three bounded requests; only synthetic prompts and a local in-memory echo tool.
import { createVertex } from "@zhivex-ai/vertex";
import { ProviderHTTPError, ProviderToolCallError, streamText, tool } from "@zhivex-ai/core";
import { z } from "zod";

const modelId = process.env.VERTEX_STREAM_SAFETY_MODEL ?? "gemini-2.5-flash-lite";
const limits = { timeoutMs: 30_000, maxTokens: 128, maxRetries: 0, maxSteps: 1 };
const records: Record<string, unknown>[] = [];
if (!process.env.VERTEX_API_KEY) throw new Error("Missing Vertex credentials");
const attempts = Math.max(1, Math.min(3, Number(process.env.VERTEX_STREAM_SAFETY_ATTEMPTS) || 3));
for (let attempt = 1; attempt <= attempts; attempt++) {
  let wire: Promise<Record<string, unknown>> = Promise.resolve({});
  const model = createVertex({ apiKey: process.env.VERTEX_API_KEY, fetch: async (input, init) => {
    const response = await fetch(input, init);
    if (response.ok) wire = response.clone().text().then(text => {
      const frames = text.split("\n").filter(line => line.startsWith("data: ") && !line.includes("[DONE]")).map(line => JSON.parse(line.slice(6)));
      const candidates = frames.flatMap(frame => frame.candidates ?? []);
      return {
        wireToolCalls: candidates.flatMap(candidate => candidate.content?.parts ?? []).filter(part => part.functionCall).length,
        providerFinishReasons: candidates.map(candidate => candidate.finishReason).filter(Boolean)
      };
    }).catch(() => ({ wireSummaryUnavailable: true }));
    return response;
  } })(modelId);
  let executions = 0;
  const calls: string[] = [];
  const result = streamText({ ...limits, model, prompt: "Call echo exactly once with value architecture-ok.",
    toolChoice: { type: "tool", toolName: "echo" },
    tools: { echo: tool({ name: "echo", description: "Echo a test value", schema: z.object({ value: z.string() }), execute: async ({ value }) => { executions++; return { value }; } }) }
  });
  const outcome = result.collect().then(output => ({ output, error: undefined })).catch((error: unknown) => ({ output: undefined, error }));
  try {
    for await (const event of result.eventStream) if (event.type === "tool-call") calls.push(event.toolCall.id);
  } catch { /* collect() retains the authoritative error. */ }
  const { output, error } = await outcome;
  const wireMetadata = await wire;
  const protectedFailure = error instanceof ProviderToolCallError && executions === 0 && calls.length === 0 && !error.effectsPossible;
  const valid = !!output && output.finishReason === "tool-calls" && calls.length > 0 && calls.length === new Set(calls).size && executions === calls.length;
  const record = {
    attempt, model: modelId, ...wireMetadata,
    status: valid ? "passed" : protectedFailure ? "protected_provider_failure" : "failed",
    emittedToolCalls: calls.length, executions, uniqueIds: new Set(calls).size,
    ...(error instanceof ProviderToolCallError ? { diagnosticCode: error.diagnosticCode, reason: error.reason, usage: error.usage } : {}),
    ...(error instanceof ProviderHTTPError ? { httpStatus: error.status } : {}),
    ...(output ? { finishReason: output.finishReason, usage: output.usage } : {}),
    ...(error && !(error instanceof ProviderToolCallError) ? { errorType: error instanceof Error ? error.name : "unknown" } : {})
  };
  records.push(record);
  console.log(JSON.stringify(record));
  if (!valid && !protectedFailure) process.exitCode = 1;
}
console.log(JSON.stringify({ schemaVersion: 1, checkedAt: new Date().toISOString(), evidence: "installed-package-live", limits, records }));
