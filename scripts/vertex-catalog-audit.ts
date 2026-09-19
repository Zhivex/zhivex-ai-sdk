import { vertexCatalogFragment } from "../packages/sdk/src/catalog/providers/vertex.js";
import { createVertex } from "../packages/vertex/src/index.js";
import type { ModelCapabilities } from "../packages/core/src/types.js";

// No remote calls: inspect the factories consumers actually receive.
const vertex = createVertex({ projectId: "catalog-audit", accessToken: "synthetic", location: "global", fetch: async () => { throw new Error("Catalog audit must not call the network"); } });
const lines = ["# Vertex catalog and adapter matrix", "", `Inventory revision: ${vertexCatalogFragment.revision}. Entries: ${vertexCatalogFragment.entries.length}.`, "",
  "Generated with `bun scripts/vertex-catalog-audit.ts`. Capabilities come from the", "adapter factories, not from the catalog. This is an offline routing/contract", "audit, not proof of model access, live behavior or complete platform coverage.", "",
  "Lifecycle labels are evaluated at the inventory revision date. A retired model", "can remain as historical inventory; factory construction does not verify access.", "",
  "Flags retain the shared ModelCapabilities meanings. In particular, streaming", "describes the generic generation contract; Live uses its separate bidirectional", "session contract even where that flag is false. Native OCR has no such flags.", "",
  "| Model | Factory / native client | Lifecycle | Streaming | Tools | Structured output | Vision | Reasoning |", "| --- | --- | --- | --- | --- | --- | --- | --- |" ];
for (const entry of vertexCatalogFragment.entries) {
  const id = entry.modelId;
  let route: string;
  let capabilities: ModelCapabilities | undefined;
  if (id === "virtual-try-on-001") { route = "virtualTryOn.generate (native)"; }
  else if (/embedding|^intfloat\//.test(id)) { route = "embeddingModel"; capabilities = vertex.embeddingModel(id).capabilities; }
  else if (/ocr/.test(id)) { route = "ocr.process (native)"; }
  else if (/^veo-|^gemini-omni-/.test(id)) { route = "videoGenerationModel"; capabilities = vertex.videoGenerationModel!(id).capabilities; }
  else if (/^lyria-/.test(id)) { route = "musicGenerationModel"; capabilities = vertex.musicGenerationModel!(id).capabilities; }
  else if (id.includes("live")) { route = "realtimeModel"; capabilities = vertex.realtimeModel!(id).capabilities; }
  else if (id === "gemini-3.5-transcribe-preview") { route = "transcriptionModel"; capabilities = vertex.transcriptionModel(id).capabilities; }
  else if (id.includes("tts")) { route = "speechModel"; capabilities = vertex.speechModel!(id).capabilities; }
  else if (id.includes("image")) { route = "imageGenerationModel"; capabilities = vertex.imageGenerationModel!(id).capabilities; }
  else { route = id.includes("codestral") ? "languageModel / fim (native)" : "languageModel"; capabilities = vertex(id).capabilities; }
  if (id.startsWith("xai/grok-")) { vertex.responsesModel(id); route += " / responsesModel (global)"; }
  const lifecycle = entry.lifecycle?.retiredAt && entry.lifecycle.retiredAt <= vertexCatalogFragment.revision ? "retired" : entry.lifecycle?.deprecatedAt && entry.lifecycle.deprecatedAt <= vertexCatalogFragment.revision ? "deprecated" : "no retirement recorded";
  const flags = (["streaming", "tools", "structuredOutput", "vision", "reasoning"] as const).map(key => capabilities ? capabilities[key] === true ? "yes" : capabilities[key] === false ? "no" : "unspecified" : "native contract");
  lines.push(`| ${id} | ${route} | ${lifecycle} | ${flags.join(" | ")} |`);
}
console.log(lines.join("\n"));
