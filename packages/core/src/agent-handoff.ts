import { getTextFromMessages } from "./messages.js";
import { createTextMessage } from "./messages.js";
import { runAgent } from "./agent.js";
import type { AgentDefinition, AgentHandoff, AgentRunInput, AgentRunOutput, AgentRunState, JsonValue, LanguageModel } from "./types.js";

const randomId = () => `handoff_${Math.random().toString(36).slice(2, 10)}`;

const normalizeSource = (source: AgentRunOutput | AgentRunState): AgentRunState =>
  "state" in source ? source.state : source;

export const createAgentHandoff = (options: {
  source: AgentRunOutput | AgentRunState;
  toAgentId?: string;
  summary?: string;
  metadata?: Record<string, JsonValue>;
  contextMessages?: AgentHandoff["contextMessages"];
}): AgentHandoff => {
  const state = normalizeSource(options.source);

  return {
    id: randomId(),
    fromRunId: state.runId,
    fromAgentId: state.agentId,
    toAgentId: options.toAgentId,
    summary: options.summary ?? state.outputText ?? getTextFromMessages(state.messages),
    contextMessages: options.contextMessages ?? state.messages,
    metadata: options.metadata
  };
};

export const createAgentHandoffMessage = (handoff: AgentHandoff) =>
  createTextMessage(
    "user",
    `Handoff from ${handoff.fromAgentId ?? "another agent"}.\nSummary: ${handoff.summary}`
  );

export const runAgentHandoff = <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  handoff: AgentHandoff,
  input: Omit<AgentRunInput<TModel>, "handoff"> = {}
): Promise<AgentRunOutput> => runAgent(agent, { ...(input as AgentRunInput<TModel>), handoff });
