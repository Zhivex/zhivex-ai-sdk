import type { AgentDefinition } from "../types.js";

const disabledMemory = Symbol("disabled-agent-memory");

export const hasDisabledMemory = (agent: AgentDefinition): boolean =>
  (agent as AgentDefinition & { [disabledMemory]?: boolean })[disabledMemory] === true;

/** Clone the definition tree so an invocation cannot mutate shared memory defaults. */
export const withoutInvocationMemory = <T extends AgentDefinition>(agent: T): T => {
  const visited = new Map<AgentDefinition, AgentDefinition>();
  const visit = (definition: AgentDefinition): AgentDefinition => {
    const previous = visited.get(definition);
    if (previous) return previous;
    const next = { ...definition, memory: undefined, [disabledMemory]: true };
    visited.set(definition, next);
    next.subagents = definition.subagents?.map((subagent) => ({
      ...subagent,
      agent: visit(subagent.agent)
    }));
    return next;
  };
  return visit(agent) as T;
};
