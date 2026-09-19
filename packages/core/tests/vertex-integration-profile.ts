import { vertexChatProfile } from "../../vertex/src/chat-profiles.js";
import { createVertex } from "../../vertex/src/index.js";
import type { IntegrationLanguageProvider } from "./integration-registry.js";

/** Explicit ADC opt-in is configuration, never proof that Google grants access. */
export const vertexIntegrationCredentials = (env: Record<string, string | undefined>, requiresBearer: boolean) => {
  const projectId = env.GOOGLE_CLOUD_PROJECT ?? env.GCLOUD_PROJECT;
  const baseURL = env.VERTEX_BASE_URL;
  const token = env.VERTEX_ACCESS_TOKEN ?? env.GOOGLE_ACCESS_TOKEN;
  const apiKey = env.VERTEX_API_KEY ?? env.GOOGLE_API_KEY;
  const accessToken = token && (projectId || baseURL) ? token : undefined;
  const adcRequested = env.VERTEX_INTEGRATION_USE_ADC === "1";
  // Match the provider's real precedence. Do not claim ADC while an environment
  // token or API key would select another mode, or downgrade an ADC opt-in.
  const adcConfigured = adcRequested && !token && !apiKey && Boolean(projectId || baseURL);
  return {
    configured: adcRequested ? adcConfigured : Boolean(accessToken || (!requiresBearer && apiKey)),
    options: { projectId, baseURL, accessToken, apiKey,
      location: env.VERTEX_LOCATION ?? env.GOOGLE_CLOUD_LOCATION },
    requirement: adcRequested
      ? "VERTEX_INTEGRATION_USE_ADC=1 requires a project or base URL, working ADC, and no token/API-key environment variables"
      : requiresBearer
        ? "Google bearer token and project/base URL, or VERTEX_INTEGRATION_USE_ADC=1 with working ADC"
        : "Google API key, bearer token with project/base URL, or VERTEX_INTEGRATION_USE_ADC=1 with working ADC"
  };
};

/** Select test contracts from the host adapter, without resolving real credentials. */
export const vertexIntegrationProfile = (modelId: string) => {
  const model = createVertex({ projectId: "contract-only", location: "global", accessToken: "contract-only" })(modelId);
  const partnerProfile = vertexChatProfile(modelId);
  const gemini = /^gemini-/.test(modelId);
  const claude = /^claude-/.test(modelId);
  const reasoning = !model.capabilities.reasoning ? undefined
    : gemini ? /^gemini-3/.test(modelId) ? { effort: "low" as const } : { budgetTokens: 256 }
    : partnerProfile.thinkingControl !== undefined ? { effort: "low" as const }
    : claude ? { budgetTokens: 1024 } : undefined;
  const supports: IntegrationLanguageProvider["supports"] = {
    streaming: model.capabilities.streaming, tools: model.capabilities.tools,
    structuredOutputMode: model.capabilities.structuredOutput ? "native" : "prompted",
    embeddings: gemini, ...(reasoning ? { reasoning } : {})
  };
  return {
    supports, requiresBearer: !gemini,
    omitTemperature: claude || /^gemini-3\.(?:[678]-flash|5-flash-lite)/.test(modelId),
    toolChoiceForTool: (toolName: string) => claude || /^openai\/gpt-oss-/.test(modelId) ? "auto" as const : { type: "tool" as const, toolName },
    textMaxTokens: 256, toolMaxTokens: 512, reasoningMaxTokens: claude ? 2048 : 512,
    omitTemperatureForReasoning: claude
  };
};
