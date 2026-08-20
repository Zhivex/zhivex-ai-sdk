import { createTextMessage, getTextFromMessages } from "./messages.js";
import { createSecureId } from "#secure-id";
import type { AgentHandoff, AgentRunOutput, AgentRunState, JsonValue } from "./types.js";

const normalizeSource = (source: AgentRunOutput | AgentRunState): AgentRunState =>
  "state" in source ? source.state : source;

export const createAgentHandoff = (options: {
  source: AgentRunOutput | AgentRunState;
  /** Optional caller-supplied durable ID. A cryptographically secure UUID is used by default. */
  id?: string;
  toAgentId?: string;
  summary?: string;
  metadata?: Record<string, JsonValue>;
  contextMessages?: AgentHandoff["contextMessages"];
}): AgentHandoff => {
  const state = normalizeSource(options.source);

  return {
    id: options.id ?? createSecureId("handoff"),
    fromRunId: state.runId,
    scope: state.scope,
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
