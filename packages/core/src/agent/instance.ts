import {
  z
} from "zod";
import type {
  AgentDefinition,
  AgentRunInput,
  AgentRunOutput,
  AgentRunState,
  AgentRunPolicy,
  AgentRunStore,
  AgentStreamResult,
  JsonValue,
  LanguageModel
} from "../types.js";
import {
  resumeAgent,
  runAgent,
  streamAgent
} from "./execution.js";
import {
  createAgent
} from "./definition.js";

export class Agent<
  TModel extends LanguageModel = LanguageModel,
  TContext = unknown,
  TOutput = unknown,
  TContextInput = TContext
> implements AgentDefinition<TModel, TContext, TOutput, TContextInput> {
  id?: string;
  name?: string;
  model: TModel;
  instructions?: string;
  contextSchema?: z.ZodType<TContext, TContextInput>;
  tools?: AgentDefinition<TModel>["tools"];
  maxSteps?: number;
  streamBuffer?: AgentDefinition<TModel>["streamBuffer"];
  temperature?: number;
  maxTokens?: number;
  reasoning?: AgentDefinition<TModel>["reasoning"];
  outputSchema?: z.ZodType<TOutput>;
  outputMode?: AgentDefinition<TModel, TContext, TOutput, TContextInput>["outputMode"];
  outputName?: string;
  outputDescription?: string;
  toolExecution?: AgentDefinition<TModel>["toolExecution"];
  toolApprovalPolicy?: AgentDefinition<TModel, TContext, TOutput, TContextInput>["toolApprovalPolicy"];
  toolApprovalSigner?: AgentDefinition<TModel>["toolApprovalSigner"];
  inputGuardrails?: AgentDefinition<TModel, TContext, TOutput, TContextInput>["inputGuardrails"];
  outputGuardrails?: AgentDefinition<TModel, TContext, TOutput, TContextInput>["outputGuardrails"];
  providerOptions?: AgentDefinition<TModel>["providerOptions"];
  subagents?: AgentDefinition<TModel>["subagents"];
  harness?: AgentDefinition<TModel>["harness"];
  executionEnvironment?: AgentDefinition<TModel, TContext>["executionEnvironment"];
  compaction?: AgentDefinition<TModel, TContext>["compaction"];
  policy?: AgentRunPolicy;
  metadata?: Record<string, JsonValue>;
  store?: AgentRunStore;
  memory?: AgentDefinition<TModel>["memory"];
  onTelemetryEvent?: AgentDefinition<TModel>["onTelemetryEvent"];
  hookFailurePolicy?: AgentDefinition<TModel>["hookFailurePolicy"];

  constructor(definition: AgentDefinition<TModel, TContext, TOutput, TContextInput>) {
    Object.assign(this, createAgent(definition));
    this.model = definition.model;
  }

  toDefinition(): AgentDefinition<TModel, TContext, TOutput, TContextInput> {
    return createAgent<TModel, TContext, TOutput, TContextInput>({
      id: this.id,
      name: this.name,
      model: this.model,
      instructions: this.instructions,
      contextSchema: this.contextSchema,
      tools: this.tools,
      maxSteps: this.maxSteps,
      streamBuffer: this.streamBuffer,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      reasoning: this.reasoning,
      outputSchema: this.outputSchema,
      outputMode: this.outputMode,
      outputName: this.outputName,
      outputDescription: this.outputDescription,
      toolExecution: this.toolExecution,
      toolApprovalPolicy: this.toolApprovalPolicy,
      toolApprovalSigner: this.toolApprovalSigner,
      inputGuardrails: this.inputGuardrails,
      outputGuardrails: this.outputGuardrails,
      providerOptions: this.providerOptions,
      subagents: this.subagents,
      harness: this.harness,
      executionEnvironment: this.executionEnvironment,
      compaction: this.compaction,
      policy: this.policy,
      metadata: this.metadata,
      store: this.store,
      memory: this.memory,
      onTelemetryEvent: this.onTelemetryEvent,
      hookFailurePolicy: this.hookFailurePolicy
    });
  }

  run(input: AgentRunInput<TModel, TContext, NoInfer<TContextInput>> = {}): Promise<AgentRunOutput<TOutput>> {
    return runAgent<TModel, TContext, TOutput, TContextInput>(this.toDefinition(), input);
  }

  resume(
    input: AgentRunInput<TModel, TContext, NoInfer<TContextInput>> & { state: AgentRunState }
  ): Promise<AgentRunOutput<TOutput>> {
    return resumeAgent<TModel, TContext, TOutput, TContextInput>(this.toDefinition(), input);
  }

  stream(input: AgentRunInput<TModel, TContext, NoInfer<TContextInput>> = {}): AgentStreamResult<TOutput> {
    return streamAgent<TModel, TContext, TOutput, TContextInput>(this.toDefinition(), input);
  }
}
