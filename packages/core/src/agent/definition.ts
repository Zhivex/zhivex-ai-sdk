import type {
  AgentDefinition,
  LanguageModel,
  PrepareSubagentsForAgentOptions
} from "../types.js";
import {
  cloneMetadata
} from "./common.js";

export const createAgent = <
  TModel extends AgentDefinition["model"],
  TContext = unknown,
  TOutput = unknown
>(
  definition: AgentDefinition<TModel, TContext, TOutput>
): AgentDefinition<TModel, TContext, TOutput> => ({
  ...definition,
  metadata: cloneMetadata(definition.metadata)
});

export const prepareSubagentsForAgent = <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  options: PrepareSubagentsForAgentOptions = {}
): AgentDefinition<TModel> => {
  const store = options.store ?? agent.store;
  const memory = options.memory ?? agent.memory;
  const onTelemetryEvent = options.onTelemetryEvent ?? agent.onTelemetryEvent;
  const toolApprovalPolicy = options.toolApprovalPolicy ?? agent.toolApprovalPolicy;
  const toolExecution = options.toolExecution ?? agent.toolExecution;
  const executionEnvironment = options.executionEnvironment ?? agent.executionEnvironment;
  const compaction = options.compaction ?? agent.compaction;
  const defaultMetadata = cloneMetadata(agent.metadata, options.metadata);

  return {
    ...agent,
    metadata: cloneMetadata(agent.metadata),
    subagents: (agent.subagents ?? []).map((subagent) => ({
      ...subagent,
      metadata: cloneMetadata(defaultMetadata, subagent.metadata),
      agent: {
        ...subagent.agent,
        store: subagent.agent.store ?? store,
        memory: subagent.agent.memory ?? memory,
        onTelemetryEvent: subagent.agent.onTelemetryEvent ?? onTelemetryEvent,
        toolApprovalPolicy: subagent.agent.toolApprovalPolicy ?? toolApprovalPolicy,
        toolExecution: subagent.agent.toolExecution ?? toolExecution,
        executionEnvironment: subagent.agent.executionEnvironment ?? executionEnvironment,
        compaction: subagent.agent.compaction ?? compaction,
        metadata: cloneMetadata(defaultMetadata, subagent.agent.metadata)
      }
    }))
  };
};
