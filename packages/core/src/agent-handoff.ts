import { runAgent } from "./agent.js";
export { createAgentHandoff, createAgentHandoffMessage } from "./agent-handoff-contracts.js";
import type { AgentDefinition, AgentHandoff, AgentRunInput, AgentRunOutput, LanguageModel } from "./types.js";

export const runAgentHandoff = <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  handoff: AgentHandoff,
  input: Omit<AgentRunInput<TModel>, "handoff"> = {}
): Promise<AgentRunOutput> => runAgent(agent, {
  ...(input as AgentRunInput<TModel>),
  scope: input.scope ?? handoff.scope,
  handoff
});
