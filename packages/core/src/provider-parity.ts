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
  embeddings: boolean;
  audioInput: boolean;
  audioOutput: boolean;
  browserTokens: boolean;
  hostedToolSummary?: string;
  structuredOutputSummary?: string;
  reasoningSummary?: string;
  notes?: string;
}

export interface ProviderSupportMatrix {
  entries: ProviderAgentSupport[];
}

export type ProviderSupportDriftExpectedEntry = Partial<ProviderAgentSupport> & {
  provider: string;
  modelId?: string;
};

export interface ProviderSupportDriftExpectedMatrix {
  entries: ProviderSupportDriftExpectedEntry[];
}

export type ProviderSupportMatrixFormat = "markdown";

export interface ProviderSupportDrift {
  provider: string;
  modelId?: string;
  field?: keyof ProviderAgentSupport;
  expected?: unknown;
  actual?: unknown;
}

export interface ProviderSupportDriftReport {
  ok: boolean;
  missing: ProviderSupportDrift[];
  unexpected: ProviderSupportDrift[];
  changed: ProviderSupportDrift[];
}

export type ProviderSupportMatrixEntry =
  | LanguageModel
  | {
      provider?: string;
      modelId?: string;
      model: LanguageModel;
      summary?: Partial<Pick<ProviderAgentSupport, "hostedToolSummary" | "structuredOutputSummary" | "reasoningSummary" | "notes">>;
    };

const boolText = (value: boolean): string => (value ? "yes" : "no");

const tierText = (tier: AgentSupportTier): string => {
  switch (tier) {
    case "tier-a":
      return "Tier A";
    case "tier-b":
      return "Tier B";
    case "tier-c":
      return "Tier C";
  }
};

const hostedSummary = (agent: ReturnType<typeof getAgentCapabilities>): string => {
  const features = [
    agent.hostedWebSearch ? "web search" : undefined,
    agent.hostedFileSearch ? "file search" : undefined,
    agent.remoteMcp ? "remote MCP" : undefined,
    agent.computerUse ? "computer use" : undefined,
    agent.codeExecution ? "code execution" : undefined,
    agent.shell ? "shell" : undefined,
    agent.applyPatch ? "apply patch" : undefined,
    agent.toolSearch ? "tool search" : undefined,
    agent.webExtraction ? "web extraction" : undefined,
    agent.skills ? "skills" : undefined,
    agent.programmaticToolCalling ? "programmatic tool calling" : undefined,
    agent.multiAgent ? "multi-agent" : undefined,
    agent.toolsets ? "toolsets" : undefined
  ].filter((feature): feature is string => Boolean(feature));
  return features.length ? features.join(", ") : "no";
};

const structuredSummary = (model: LanguageModel): string =>
  model.capabilities.structuredOutput
    ? model.capabilities.jsonMode
      ? "native"
      : "yes"
    : "no";

const reasoningSummary = (model: LanguageModel): string => (model.capabilities.reasoning ? "yes" : "no");

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
    webSearch: model.capabilities.webSearch,
    embeddings: model.capabilities.embeddings,
    audioInput: model.capabilities.audioInput,
    audioOutput: model.capabilities.audioOutput,
    browserTokens: model.capabilities.realtime?.browserTokens ?? false,
    hostedToolSummary: hostedSummary(agent),
    structuredOutputSummary: structuredSummary(model),
    reasoningSummary: reasoningSummary(model)
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
      modelId: "model" in entry ? entry.modelId ?? model.modelId : model.modelId,
      ...("model" in entry ? entry.summary ?? {} : {})
    };
  })
});

const row = (values: string[]) => `| ${values.join(" | ")} |`;

export const renderProviderSupportMatrix = (
  matrix: ProviderSupportMatrix,
  options: { format?: ProviderSupportMatrixFormat } = {}
): string => {
  const format = options.format ?? "markdown";
  if (format !== "markdown") {
    throw new Error(`Unsupported provider support matrix format "${format}".`);
  }

  const header = [
    "Provider",
    "`streamText`",
    "Tools",
    "`toolChoice`",
    "Structured output",
    "Embeddings",
    "Audio in",
    "Audio out",
    "Realtime sessions",
    "Browser tokens",
    "Reasoning",
    "Web search",
    "Hosted tools / MCP",
    "Agent tier"
  ];

  return [
    row(header),
    row(header.map(() => "---")),
    ...matrix.entries.map((entry) =>
      row([
        entry.provider,
        boolText(entry.streaming),
        boolText(entry.portableToolLoop),
        boolText(entry.toolChoice),
        entry.structuredOutputSummary ?? boolText(entry.structuredOutput),
        boolText(entry.embeddings),
        boolText(entry.audioInput),
        boolText(entry.audioOutput),
        boolText(entry.realtime),
        boolText(entry.browserTokens),
        entry.reasoningSummary ?? boolText(entry.reasoning),
        boolText(entry.webSearch),
        entry.hostedToolSummary ?? boolText(entry.hostedTools),
        tierText(entry.agentTier)
      ])
    )
  ].join("\n");
};

const entryKey = (entry: { provider: string; modelId?: string }, includeModel = true): string =>
  includeModel ? `${entry.provider}:${entry.modelId}` : entry.provider;

export const createProviderSupportDriftReport = (
  actual: ProviderSupportMatrix,
  expected: ProviderSupportDriftExpectedMatrix
): ProviderSupportDriftReport => {
  const missing: ProviderSupportDrift[] = [];
  const unexpected: ProviderSupportDrift[] = [];
  const changed: ProviderSupportDrift[] = [];
  const actualByFullKey = new Map(actual.entries.map((entry) => [entryKey(entry), entry]));
  const actualByProvider = new Map(actual.entries.map((entry) => [entry.provider, entry]));
  const matchedActualKeys = new Set<string>();

  for (const expectedEntry of expected.entries) {
    const match = expectedEntry.modelId
      ? actualByFullKey.get(entryKey(expectedEntry))
      : actualByProvider.get(expectedEntry.provider);
    if (!match) {
      missing.push({
        provider: expectedEntry.provider,
        modelId: expectedEntry.modelId
      });
      continue;
    }

    matchedActualKeys.add(entryKey(match));
    for (const [field, expectedValue] of Object.entries(expectedEntry) as Array<[keyof ProviderAgentSupport, unknown]>) {
      const actualValue = match[field];
      if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
        changed.push({
          provider: expectedEntry.provider,
          modelId: expectedEntry.modelId,
          field,
          expected: expectedValue,
          actual: actualValue
        });
      }
    }
  }

  for (const actualEntry of actual.entries) {
    if (!matchedActualKeys.has(entryKey(actualEntry))) {
      unexpected.push({
        provider: actualEntry.provider,
        modelId: actualEntry.modelId
      });
    }
  }

  return {
    ok: missing.length === 0 && unexpected.length === 0 && changed.length === 0,
    missing,
    unexpected,
    changed
  };
};
