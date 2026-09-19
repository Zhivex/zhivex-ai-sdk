import type { ModelCapabilities } from "@zhivex-ai/core/provider";

// Managed-host profiles, not capabilities inferred from the model's author.
// Inventory: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/maas/use-open-models
// Model-specific controls: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/maas/capabilities/thinking
// Keep unknown IDs usable for text without promising unverified advanced features.
const baseline: ModelCapabilities = {
  streaming: true, tools: false, structuredOutput: false, jsonMode: false,
  toolChoice: false, parallelToolCalls: false, vision: false, files: false,
  audioInput: false, audioOutput: false, embeddings: false, reasoning: false,
  webSearch: false, toolHistory: "json",
  agentCapabilities: { supportTier: "tier-b", toolChoiceNone: false, approvalRequests: false,
    hostedWebSearch: false, hostedFileSearch: false, remoteMcp: false,
    computerUse: false, codeExecution: false, toolsets: false }
};

type ThinkingControl = "effort" | "thinking" | "enable_thinking";
type Profile = { vision?: boolean; reasoning?: boolean; thinkingControl?: ThinkingControl; tools?: boolean; structuredOutput?: boolean; jsonMode?: boolean };
const profiles: Record<string, Profile> = Object.create(null);
const add = (ids: string[], profile: Profile = {}) => {
  for (const id of ids) profiles[id] = { tools: true, structuredOutput: true, jsonMode: true, ...profile };
};
add([
  "meta/llama-3.3-70b-instruct-maas",
  "qwen/qwen3-235b-a22b-instruct-2507-maas",
  "qwen/qwen3-coder-480b-a35b-instruct-maas",
  "qwen/qwen3-next-80b-a3b-instruct-maas"
]);
add([
  "meta/llama-4-maverick-17b-128e-instruct-maas",
  "meta/llama-4-scout-17b-16e-instruct-maas",
  "mistralai/mistral-medium-3", "mistralai/mistral-small-2503",
  "xai/grok-4.20-non-reasoning", "xai/grok-4.1-fast-non-reasoning"
], { vision: true });
add([
  "deepseek-ai/deepseek-r1-0528-maas", "qwen/qwen3-next-80b-a3b-thinking-maas",
  "moonshotai/kimi-k2-thinking-maas", "minimaxai/minimax-m2-maas"
], { reasoning: true });
add(["openai/gpt-oss-20b-maas", "openai/gpt-oss-120b-maas"], { reasoning: true, thinkingControl: "effort" });
add(["deepseek-ai/deepseek-v3.1-maas", "deepseek-ai/deepseek-v3.2-maas"], { reasoning: true, thinkingControl: "thinking" });
add(["zai-org/glm-4.7-maas", "zai-org/glm-5-maas", "zai-org/glm-5.2-maas"], { reasoning: true, thinkingControl: "enable_thinking" });
// The model card's Thinking row conflicts with the dedicated thinking guide;
// retain the guide's explicit enable_thinking serving contract for this ID only.
add(["google/gemma-4-26b-a4b-it-maas"], { vision: true, reasoning: true, thinkingControl: "enable_thinking" });
add(["xai/grok-4.6", "xai/grok-4.3", "xai/grok-4.20-reasoning", "xai/grok-4.1-fast-reasoning"], { vision: true, reasoning: true });
add(["mistralai/codestral-2"]);
// AI21 documents JSON-object mode, not response_format.json_schema.
// Vertex's 1.5 deployments are retired; do not infer newer-model features.
add(["ai21/jamba-1.5-mini", "ai21/jamba-1.5-large"], { structuredOutput: false });
profiles["deepseek-ai/deepseek-ocr-maas"] = { vision: true };
profiles["deepseek-ai/deepseek-r1"] = { reasoning: true };

export const vertexChatProfile = (id: string): { capabilities: ModelCapabilities; thinkingControl?: ThinkingControl } => {
  // Publisher rawPredict revisions identify a deployment of the same model.
  const key = /^(?:mistralai|ai21)\//.test(id) ? id.split("@")[0] : id;
  const profile = profiles[key] ?? {};
  const { thinkingControl, ...declared } = profile;
  const tools = profile.tools ?? false;
  return {
    thinkingControl,
    capabilities: { ...baseline, ...declared, tools, toolChoice: tools, parallelToolCalls: tools,
      agentCapabilities: { ...baseline.agentCapabilities!, toolChoiceNone: tools },
      ...(profile.thinkingControl === "effort" ? { reasoningEfforts: ["low", "medium", "high"] } : {})
    }
  };
};
