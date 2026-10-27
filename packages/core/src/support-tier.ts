import type { AgentCapabilities, AgentSupportTier, ModelCapabilities } from "./types.js";

/**
 * Hosted-tool floor for text Tier A.
 *
 * This is the intersection of hosted-tool flags that every current text Tier A
 * surface actually advertises: OpenAI chat, Azure OpenAI chat, and Bedrock
 * `runtime: "openai"`.
 *
 * Remote MCP is required separately, together with approval requests. It is
 * not repeated here.
 *
 * Excluded, with the reason they are not part of the floor:
 *
 * - `hostedFileSearch`, `codeExecution`: Bedrock's OpenAI-compatible runtime
 *   does not advertise them. Mantle rejects `code_interpreter`.
 * - `computerUse`, `shell`, `applyPatch`, `toolSearch`, `skills`,
 *   `programmaticToolCalling`, `multiAgent`: model-gated inside OpenAI and
 *   Azure. `gpt-4o-mini` is public Tier A without them.
 * - `hostedWebSearch` is the only hosted tool shared by all three text Tier A
 *   surfaces and absent from the Tier B hosted-tool providers that lack
 *   approval-capable remote MCP as a set. OpenAI and Azure realtime
 *   conversation stay Tier A through the realtime equivalent below, because
 *   those session APIs already advertise approval-capable remote MCP and do
 *   not advertise the text Responses web-search tool.
 */
export const TIER_A_MINIMUM_HOSTED_TOOLS = ["hostedWebSearch"] as const satisfies readonly (keyof AgentCapabilities)[];

export type TierAMinimumHostedTool = (typeof TIER_A_MINIMUM_HOSTED_TOOLS)[number];

const agentFlags = (capabilities: Pick<ModelCapabilities, "agentCapabilities">): AgentCapabilities | undefined =>
  capabilities.agentCapabilities;

/** Provider-emitted approval for a remote MCP server, not an SDK-local approval policy. */
export const hasApprovalCapableRemoteMcp = (
  capabilities: Pick<ModelCapabilities, "agentCapabilities">
): boolean => {
  const agent = agentFlags(capabilities);
  return agent?.remoteMcp === true && agent.approvalRequests === true;
};

const hasMinimumHostedTools = (capabilities: Pick<ModelCapabilities, "agentCapabilities">): boolean => {
  const agent = agentFlags(capabilities);
  return TIER_A_MINIMUM_HOSTED_TOOLS.every((tool) => agent?.[tool] === true);
};

/**
 * Realtime equivalent of the text hosted-tool floor.
 *
 * OpenAI and Azure realtime conversation are already public Tier A with
 * `remoteMcp` and `approvalRequests`, and without hosted web search.
 * A tool-capable realtime session that emits provider MCP approval requests
 * meets Tier A without `hostedWebSearch`. Tool-less translation and
 * transcription sessions do not.
 *
 * Do not set `remoteMcp` and `approvalRequests` from provider documentation
 * alone. A new Tier A declaration needs a passed live certification.
 * Qwen 3.8 Omni Flash realtime stays Tier B until that certification passes.
 */
export const hasRealtimeApprovalEquivalent = (
  capabilities: Pick<ModelCapabilities, "agentCapabilities" | "realtime">
): boolean =>
  capabilities.realtime?.sessions === true &&
  capabilities.realtime.tools === true &&
  hasApprovalCapableRemoteMcp(capabilities);

/**
 * Derive the agent support tier from capability flags.
 *
 * - Tier A: `tools`, plus approval-capable remote MCP
 *   (`remoteMcp && approvalRequests`), plus every flag in
 *   {@link TIER_A_MINIMUM_HOSTED_TOOLS}, or the realtime equivalent
 *   ({@link hasRealtimeApprovalEquivalent}).
 * - Tier B: `tools` and `agentCapabilities.durableAgent`.
 * - Tier C: every other surface.
 *
 * `durableAgent` means this surface can run the SDK durable agent loop
 * (callable tools, persisted tool results, and approval pause/resume).
 * It is independent of live certification. Basic tool loops set it false
 * even when `tools` is true: OpenRouter, Kimi, and Ollama, plus Qwen Omni
 * language models whose hosted-agent flags are withheld.
 *
 * Declared `supportTier` is not an input. Callers compare this result with
 * the declared tier. This function does not promote a surface because a
 * provider document describes an approval event.
 */
export const deriveAgentSupportTier = (
  capabilities: Pick<ModelCapabilities, "tools" | "agentCapabilities" | "realtime">
): AgentSupportTier => {
  if (
    capabilities.tools === true &&
    hasApprovalCapableRemoteMcp(capabilities) &&
    (hasMinimumHostedTools(capabilities) || hasRealtimeApprovalEquivalent(capabilities))
  ) {
    return "tier-a";
  }

  if (capabilities.tools === true && capabilities.agentCapabilities?.durableAgent === true) {
    return "tier-b";
  }

  return "tier-c";
};
