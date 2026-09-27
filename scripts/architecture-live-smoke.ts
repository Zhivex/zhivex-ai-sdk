// Run from an installed consumer using Bun and an explicit env file.
// Only synthetic prompts are sent. Never log provider bodies, messages or credentials.
import { createChatCompletionsModel, createTextMessage, tool, type LanguageModel, type ModelGenerateInput, type StreamEvent } from "@zhivex-ai/core";
import { createOpenAI } from "@zhivex-ai/openai";
import { createGemini, googleSearchTool } from "@zhivex-ai/gemini";
import { createAzureOpenAI } from "@zhivex-ai/azure-openai";
import { createVertex } from "@zhivex-ai/vertex";
import { z } from "zod";

const limits = { timeoutMs: 30_000, maxRetries: 0, maxTokens: 128 };
const records: Record<string, unknown>[] = [];
const selectedCases = process.env.ARCHITECTURE_SMOKE_CASES?.split(",");
const run = async (name: string, model: string, available: boolean, check: () => Promise<Record<string, unknown>>) => {
  if (selectedCases && !selectedCases.includes(name)) return;
  const record: Record<string, unknown> = { name, model, status: "skipped_missing_credentials" };
  if (available) {
    try { Object.assign(record, { status: "passed" }, await check()); }
    catch (error) {
      Object.assign(record, { status: "failed", errorType: error instanceof Error ? error.name : "unknown" });
      if (error instanceof SmokeAssertionError) record.checks = error.checks;
      if (error && typeof error === "object" && "status" in error && typeof error.status === "number") record.httpStatus = error.status;
      process.exitCode = 1;
    }
  }
  records.push(record);
  console.log(JSON.stringify(record));
};
const requireCondition = (condition: unknown) => { if (!condition) throw new Error("SmokeAssertionFailed"); };
class SmokeAssertionError extends Error {
  constructor(readonly checks: Record<string, unknown>) { super("SmokeAssertionFailed"); }
}
const toolInput: ModelGenerateInput = {
  ...limits,
  messages: [createTextMessage("user", "Call echo exactly once with value architecture-ok.")],
  tools: { echo: tool({ name: "echo", description: "Echo a test value", schema: z.object({ value: z.string() }), execute: async ({ value }) => ({ value }) }) },
  toolChoice: { type: "tool", toolName: "echo" }
};
const streamCheck = async (model: LanguageModel, input: ModelGenerateInput = toolInput) => {
  const events: StreamEvent[] = [];
  for await (const event of await model.stream!(input)) events.push(event);
  const calls = events.filter(event => event.type === "tool-call");
  const finishes = events.filter(event => event.type === "finish");
  const checks = {
    toolCalls: calls.length, finishes: finishes.length,
    correctTool: calls[0]?.toolCall.name === "echo",
    correctInput: (calls[0]?.toolCall.input as { value?: string })?.value === "architecture-ok",
    finishReason: finishes[0]?.finishReason,
    providerFinishReason: finishes[0]?.providerFinishReason,
    uniqueToolIds: new Set(calls.map(event => event.toolCall.id)).size === calls.length,
    hasTerminalUsage: Boolean(finishes[0]?.usage?.totalTokens && finishes[0].usage.totalTokens > 0)
  };
  if (checks.toolCalls !== 1 || checks.finishes !== 1 || !checks.correctTool || !checks.correctInput || !checks.hasTerminalUsage || !checks.uniqueToolIds || !["stop", "tool-calls"].includes(checks.finishReason ?? "")) throw new SmokeAssertionError(checks);
  return { toolCalls: calls.length, finishReason: finishes[0]?.finishReason, usage: finishes[0]?.usage };
};

const openAIModel = process.env.ARCHITECTURE_OPENAI_MODEL ?? "gpt-6-luna";
const openAIInput: ModelGenerateInput = { ...toolInput, reasoning: { effort: "none" } };
const openAIAvailable = Boolean(process.env.OPENAI_API_KEY);
const openai = () => createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
await run("openai-chat-stream", openAIModel, openAIAvailable, () => streamCheck(openai()(openAIModel), { ...openAIInput, providerOptions: { apiMode: "chat" } }));
await run("openai-responses-stream", openAIModel, openAIAvailable, () => streamCheck(openai()(openAIModel), { ...openAIInput, providerOptions: { apiMode: "responses" } }));
await run("openai-generate", openAIModel, openAIAvailable, async () => {
  const result = await openai()(openAIModel).generate({ ...limits, reasoning: { effort: "none" }, messages: [createTextMessage("user", "Reply only OK.")] });
  requireCondition(result.text?.trim().length && result.usage?.totalTokens);
  return { finishReason: result.finishReason, usage: result.usage };
});
await run("shared-chat-transport-stream", openAIModel, openAIAvailable, () => {
  const capabilities = openai()(openAIModel).capabilities;
  return streamCheck(createChatCompletionsModel({
    provider: "openai", modelId: openAIModel, capabilities,
    send: (body, signal) => fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify(body)
    })
  }), {
    ...toolInput,
    // Host policy maps modern OpenAI token/reasoning fields outside generic Core.
    maxTokens: undefined,
    providerOptions: { max_completion_tokens: limits.maxTokens, reasoning_effort: "none" }
  });
});
await run("openai-embedding", "text-embedding-3-small", openAIAvailable, async () => {
  const result = await openai().embeddingModel!("text-embedding-3-small").embed({ values: ["architecture"], timeoutMs: 30_000, maxRetries: 0 });
  requireCondition(result.embeddings.length === 1 && result.embeddings[0]!.length > 0);
  return { dimensions: result.embeddings[0]!.length, usage: result.usage };
});

const geminiModel = process.env.ARCHITECTURE_GEMINI_MODEL ?? "gemini-2.5-flash-lite";
const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
await run("gemini-tool-stream", geminiModel, Boolean(geminiKey), async () => {
  requireCondition(googleSearchTool().type === "googleSearch");
  return streamCheck(createGemini({ apiKey: geminiKey })(geminiModel));
});
await run("vertex-tool-stream", geminiModel, Boolean(process.env.VERTEX_API_KEY), () =>
  streamCheck(createVertex({ apiKey: process.env.VERTEX_API_KEY })(geminiModel)));
const azureModel = process.env.ARCHITECTURE_AZURE_MODEL ?? process.env.AZURE_OPENAI_MODEL;
await run("azure-chat-stream", azureModel ?? "unconfigured", Boolean(process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT && azureModel), () =>
  streamCheck(createAzureOpenAI()(azureModel!)));

console.log(JSON.stringify({ schemaVersion: 1, checkedAt: new Date().toISOString(), evidence: "installed-package-live-smoke", limits, records }));
