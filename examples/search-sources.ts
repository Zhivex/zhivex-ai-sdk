import { googleSearchTool, streamText } from "@zhivex-ai/core";
import { createGemini } from "@zhivex-ai/gemini";

// GenerateContent example. Keep the latest snapshot, not appended chunk arrays.
const result = streamText({
  model: createGemini()("gemini-3.8-flash"),
  prompt: "Search for the official Gemini documentation and cite your sources.",
  tools: { search: googleSearchTool() }, maxTokens: 512, maxSteps: 1
});
let grounding: Record<string, any> = {};
let text = "";
for await (const event of result.eventStream) {
  if (event.type === "text-delta") text += event.textDelta;
  if (event.type === "provider-data" && event.provider === "gemini") {
    const data = event.data as Record<string, any>;
    if (data.type === "grounding-metadata") grounding = data.groundingMetadata;
  }
}
await result.collect();
console.log(text);
// A UI inserts links at the supplied segment offsets without reordering chunks.
for (const support of grounding.groundingSupports ?? []) {
  const links = (support.groundingChunkIndices ?? []).map((i: number) => grounding.groundingChunks?.[i]?.web).filter(Boolean);
  console.log({ segment: support.segment, links });
}
// Supply this attribution to an isolated UI renderer following Google's terms.
// The CLI prints the markup as text; it does not execute provider HTML.
console.log({ searchSuggestionsHtml: grounding.searchEntryPoint?.renderedContent });
