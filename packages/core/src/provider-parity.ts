import { getAgentCapabilities } from "./messages.js";
import type { AgentSupportTier, LanguageModel } from "./types.js";

export interface ProviderAgentSupport {
  provider: string;
  modelId: string;
  agentTier: AgentSupportTier;
  portableToolLoop: boolean;
  approvalReady: boolean;
  hostedTools: boolean;
  remoteMcp: boolean;
  codeExecution: boolean;
  shell: boolean;
  realtime: boolean;
  structuredOutput: boolean;
  reasoning: boolean;
  streaming: boolean;
  toolChoice: boolean;
  webSearch: boolean;
}

export interface ProviderSupportMatrix {
  entries: ProviderAgentSupport[];
}

export type ProviderSupportMatrixEntry =
  | LanguageModel
  | {
      provider?: string;
      modelId?: string;
      model: LanguageModel;
    };

export const inspectProviderAgentSupport = (model: LanguageModel): ProviderAgentSupport => {
  const agent = getAgentCapabilities(model);
  const hostedTools = Boolean(
    agent.hostedWebSearch ||
      agent.hostedFileSearch ||
      agent.remoteMcp ||
      agent.computerUse ||
      agent.codeExecution ||
      agent.shell ||
      agent.applyPatch ||
      agent.toolSearch ||
      agent.webExtraction ||
      agent.skills ||
      agent.toolsets
  );

  return {
    provider: model.provider,
    modelId: model.modelId,
    agentTier: agent.supportTier,
    portableToolLoop: model.capabilities.tools,
    approvalReady: agent.approvalRequests,
    hostedTools,
    remoteMcp: agent.remoteMcp,
    codeExecution: agent.codeExecution,
    shell: agent.shell ?? false,
    realtime: model.capabilities.realtime?.sessions ?? false,
    structuredOutput: model.capabilities.structuredOutput,
    reasoning: model.capabilities.reasoning,
    streaming: model.capabilities.streaming,
    toolChoice: model.capabilities.toolChoice,
    webSearch: model.capabilities.webSearch
  };
};

export const createProviderSupportMatrix = (
  entries: ProviderSupportMatrixEntry[]
): ProviderSupportMatrix => ({
  entries: entries.map((entry) => {
    const model = "model" in entry ? entry.model : entry;
    return {
      ...inspectProviderAgentSupport(model),
      provider: "model" in entry ? entry.provider ?? model.provider : model.provider,
      modelId: "model" in entry ? entry.modelId ?? model.modelId : model.modelId
    };
  })
});
