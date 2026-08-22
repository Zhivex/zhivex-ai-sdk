import { openaiCatalogFragment } from "./providers/openai.js";
import { xaiCatalogFragment } from "./providers/xai.js";
import { metaCatalogFragment } from "./providers/meta.js";
import { azureOpenaiCatalogFragment } from "./providers/azure-openai.js";
import { anthropicCatalogFragment } from "./providers/anthropic.js";
import { geminiCatalogFragment } from "./providers/gemini.js";
import { vertexCatalogFragment } from "./providers/vertex.js";
import { qwenCatalogFragment } from "./providers/qwen.js";
import { kimiCatalogFragment } from "./providers/kimi.js";
import { deepseekCatalogFragment } from "./providers/deepseek.js";
import { zaiCatalogFragment } from "./providers/zai.js";
import { openrouterCatalogFragment } from "./providers/openrouter.js";
import { bedrockCatalogFragment } from "./providers/bedrock.js";
import { ollamaCatalogFragment } from "./providers/ollama.js";

export const defaultModelCatalogFragments = Object.freeze([
  openaiCatalogFragment,
  xaiCatalogFragment,
  metaCatalogFragment,
  azureOpenaiCatalogFragment,
  anthropicCatalogFragment,
  geminiCatalogFragment,
  vertexCatalogFragment,
  qwenCatalogFragment,
  kimiCatalogFragment,
  deepseekCatalogFragment,
  zaiCatalogFragment,
  openrouterCatalogFragment,
  bedrockCatalogFragment,
  ollamaCatalogFragment
]);
