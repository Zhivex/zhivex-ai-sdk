// Copy into an installed package consumer and invoke with Bun and an explicit env file.
// Three bounded live calls; outputs only counts, status and usage.
import { createTextMessage, googleSearchTool } from "@zhivex-ai/core";
import { createQwen, qwenWebSearchTool } from "@zhivex-ai/qwen";
import { createGemini } from "@zhivex-ai/gemini";
const limits = { timeoutMs: 45000, maxRetries: 0, maxTokens: 512 };
const records: Record<string, unknown>[] = [];
const check = async (name: string, available: boolean, run: () => Promise<Record<string, unknown>>) => {
  if (!available) { records.push({ name, status: "skipped_missing_credentials" }); return; }
  try { records.push({ name, status: "passed", ...await run() }); }
  catch (error) { records.push({ name, status: "failed", errorType: error instanceof Error ? error.name : "unknown", httpStatus: (error as any)?.status }); process.exitCode = 1; }
  console.log(JSON.stringify(records.at(-1)));
};
const qwenKey = process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY;
const qwenId = process.env.QWEN_SEARCH_SMOKE_MODEL ?? "qwen3.8-flash";
const qwen = () => createQwen({ apiKey: qwenKey, baseURL: process.env.QWEN_BASE_URL })(qwenId);
const request = { ...limits, messages: [createTextMessage("user", "Use web search to find the official Qwen documentation. Reply briefly with a source URL.")], tools: { search: qwenWebSearchTool() }, reasoning: { effort: "none" as const } };
await check("qwen-responses-generate", !!qwenKey, async () => {
  const result = await qwen().generate(request);
  if (!["stop", "length"].includes(result.finishReason ?? "")) throw new Error("Unexpected finish");
  return { model: qwenId, finishReason: result.finishReason, usage: result.usage, citationParts: result.messages.flatMap(m => m.parts).filter(p => p.type === "provider-data" && (p.data as any)?.type === "response.annotations").length };
});
await check("qwen-responses-stream", !!qwenKey, async () => {
  let citations = 0, finish: any;
  for await (const event of await qwen().stream(request)) {
    if (event.type === "provider-data" && (event.data as any)?.type === "response.annotations") citations++;
    if (event.type === "finish") finish = event;
  }
  if (!finish) throw new Error("Missing finish");
  return { model: qwenId, finishReason: finish.finishReason, usage: finish.usage, citationParts: citations };
});
const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
const geminiId = process.env.GEMINI_SEARCH_SMOKE_MODEL ?? "gemini-3.8-flash";
await check("gemini-generate-content-stream", !!geminiKey, async () => {
  const model = createGemini({ apiKey: geminiKey, baseURL: process.env.GEMINI_BASE_URL })(geminiId);
  let sources = 0, attribution = false, finish: any;
  for await (const event of await model.stream({ ...limits, messages: [createTextMessage("user", "Use Google Search to find the official Gemini documentation. Give a short answer with sources.")], tools: { search: googleSearchTool() } })) {
    if (event.type === "provider-data" && (event.data as any)?.type === "grounding-metadata") {
      const metadata = (event.data as any).groundingMetadata;
      sources = metadata.groundingChunks?.filter((chunk: any) => chunk.web?.uri).length ?? 0;
      attribution = !!metadata.searchEntryPoint?.renderedContent;
    }
    if (event.type === "finish") finish = event;
  }
  if (!finish || !sources) throw new Error("Missing grounding or finish");
  return { model: geminiId, sources, attribution, finishReason: finish.finishReason, usage: finish.usage };
});
