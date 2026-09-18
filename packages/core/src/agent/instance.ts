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
  TOutput = unknown
> implements AgentDefinition<TModel, TContext, TOutput> {
  id?: string;
  name?: string;
  model: TModel;
  instructions?: string;
  contextSchema?: z.ZodType<TContext>;
  tools?: AgentDefinition<TModel>["tools"];
  maxSteps?: number;
  temperature?: number;
  maxTokens?: number;
  reasoning?: AgentDefinition<TModel>["reasoning"];
  outputSchema?: z.ZodType<TOutput>;
  outputMode?: AgentDefinition<TModel, TContext, TOutput>["outputMode"];
  outputName?: string;
  outputDescription?: string;
  toolExecution?: AgentDefinition<TModel>["toolExecution"];
  toolApprovalPolicy?: AgentDefinition<TModel, TContext, TOutput>["toolApprovalPolicy"];
  toolApprovalSigner?: AgentDefinition<TModel>["toolApprovalSigner"];
  inputGuardrails?: AgentDefinition<TModel, TContext, TOutput>["inputGuardrails"];
  outputGuardrails?: AgentDefinition<TModel, TContext, TOutput>["outputGuardrails"];
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

  constructor(definition: AgentDefinition<TModel, TContext, TOutput>) {
    Object.assign(this, createAgent(definition));
    this.model = definition.model;
  }

  toDefinition(): AgentDefinition<TModel, TContext, TOutput> {
    return createAgent<TModel, TContext, TOutput>({
      id: this.id,
      name: this.name,
      model: this.model,
      instructions: this.instructions,
      contextSchema: this.contextSchema,
      tools: this.tools,
      maxSteps: this.maxSteps,
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

  run(input: AgentRunInput<TModel, TContext> = {}): Promise<AgentRunOutput<TOutput>> {
    return runAgent<TModel, TContext, TOutput>(this.toDefinition(), input);
  }

  resume(
    input: AgentRunInput<TModel, TContext> & { state: AgentRunState }
  ): Promise<AgentRunOutput<TOutput>> {
    return resumeAgent<TModel, TContext, TOutput>(this.toDefinition(), input);
  }

  stream(input: AgentRunInput<TModel, TContext> = {}): AgentStreamResult<TOutput> {
    return streamAgent<TModel, TContext, TOutput>(this.toDefinition(), input);
  }
}
