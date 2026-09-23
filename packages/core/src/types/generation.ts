import type { BoundedReplayBroadcastOptions } from "../bounded-broadcast.js";
import type {
  z,
  ZodTypeAny
} from "zod";
import type {
  AgentApprovalRequest,
  AgentApprovalResolution,
  FinishReason,
  ProviderOptions,
  ReasoningConfig,
  RetryOptions,
  StructuredOutputConfig,
  StructuredOutputMode,
  TokenUsage
} from "./common.js";
import type {
  GenerateInputSource,
  ModelMessage,
  ToolCall,
  ToolChoice,
  ToolExecutionResult
} from "./messages.js";
import type {
  LanguageModel,
  ModelGenerateInput,
  ToolApprovalObserver,
  ToolApprovalPolicy,
  ToolApprovalSigner,
  ToolCollection,
  ToolExecutionOptions,
  ToolRuntimeContext
} from "./model-tools.js";
import type {
  GenerateResult,
  ObjectStreamEvent,
  StreamEvent
} from "./stream.js";
import type {
  GroundedGenerateResult
} from "./media-data.js";
import type {
  GroundedLanguageModel
} from "./media.js";

export type ProviderOptionsOf<TModel extends LanguageModel> = TModel extends LanguageModel<infer TProviderOptions>
  ? TProviderOptions
  : ProviderOptions;

export type GenerateTextOptions<
  TModel extends LanguageModel = LanguageModel,
  TContext = unknown
> = RetryOptions &
  GenerateInputSource & {
    model: TModel;
    system?: string;
    tools?: ToolCollection;
    toolChoice?: ToolChoice;
    toolExecution?: ToolExecutionOptions;
    toolApprovalPolicy?: ToolApprovalPolicy<TContext>;
    toolApprovalSigner?: ToolApprovalSigner;
    /** Resolved local approvals supplied by a durable agent runtime. */
    toolApprovalResolutions?: AgentApprovalResolution[];
    toolContext?: ToolRuntimeContext<TContext>;
    onToolApprovalDecision?: ToolApprovalObserver;
    /** Durable runtimes may replace the active context before each provider request. */
    prepareModelMessages?: (context: {
      messages: readonly ModelMessage[];
      step: number;
    }) => ModelMessage[] | undefined | Promise<ModelMessage[] | undefined>;
    /** Called immediately before each model request. Throw to stop the loop. */
    onBeforeModelStep?: (context: { request: ModelGenerateInput; step: number }) => void | Promise<void>;
    /** Called before a batch of approved local tool calls is executed. */
    onBeforeToolExecution?: (context: {
      request: ModelGenerateInput;
      step: number;
      toolCalls: ToolCall[];
    }) => void | Promise<void>;
    /** Durable runtimes use this hook to checkpoint a model response before tools run. */
    onModelStep?: (context: {
      request: ModelGenerateInput;
      response: GenerateResult;
      step: number;
      toolCalls: ToolCall[];
      approvalRequests: AgentApprovalRequest[];
      /** Terminal preflight failure: paired results for the entire unexecuted batch. */
      failedToolResults?: ToolExecutionResult[];
    }) => void | Promise<void>;
    /** Durable runtimes use this hook to checkpoint tool results before the next model request. */
    onToolExecutionComplete?: (context: {
      request: ModelGenerateInput;
      step: number;
      toolResults: ToolExecutionResult[];
    }) => void | Promise<void>;
    /** Existing completed steps preceding this invocation. */
    stepOffset?: number;
    /** Positive safe integer. Defaults to 1. */
    maxSteps?: number;
    /** Streaming replay/queue limits. Full replay with overflow errors is the default. */
    streamBuffer?: BoundedReplayBroadcastOptions;
    temperature?: number;
    maxTokens?: number;
    reasoning?: ReasoningConfig;
    providerOptions?: ProviderOptionsOf<TModel>;
    structuredOutput?: StructuredOutputConfig;
  };

export interface GenerateTextStep {
  request: ModelGenerateInput;
  response: GenerateResult;
}

export interface GenerateTextOutput {
  text: string;
  finishReason?: FinishReason;
  providerFinishReason?: string;
  usage?: TokenUsage;
  steps: GenerateTextStep[];
  messages: ModelMessage[];
  toolResults: ToolExecutionResult[];
  /** Local resumable approval requests produced before any tool in the batch executes. */
  approvalRequests?: AgentApprovalRequest[];
}

export type GenerateGroundedTextOptions<TModel extends GroundedLanguageModel = GroundedLanguageModel> = RetryOptions &
  GenerateInputSource & {
    model: TModel;
    system?: string;
    temperature?: number;
    maxTokens?: number;
    reasoning?: ReasoningConfig;
    providerOptions?: TModel extends GroundedLanguageModel<infer TProviderOptions> ? TProviderOptions : ProviderOptions;
  };

export interface GenerateGroundedTextOutput extends GroundedGenerateResult {
  messages: ModelMessage[];
}

export type GenerateObjectOptions<
  TSchema extends ZodTypeAny,
  TModel extends LanguageModel = LanguageModel
> = GenerateTextOptions<TModel> & {
  schema: TSchema;
  mode?: StructuredOutputMode;
  schemaName?: string;
  schemaDescription?: string;
};

export interface GenerateObjectOutput<TSchema extends ZodTypeAny> extends GenerateTextOutput {
  object: z.infer<TSchema>;
  objectMode: Exclude<StructuredOutputMode, "auto">;
}

export interface StreamObjectResult<TSchema extends ZodTypeAny> {
  eventStream: AsyncIterable<ObjectStreamEvent<z.infer<TSchema>, Partial<z.infer<TSchema>>>>;
  partialObjectStream: AsyncIterable<Partial<z.infer<TSchema>>>;
  /** Text only. Provider errors are reported by eventStream and collect(); await collect() to verify success. */
  textStream: AsyncIterable<string>;
  collect: () => Promise<GenerateObjectOutput<TSchema>>;
}

export interface StreamTextResult {
  eventStream: AsyncIterable<StreamEvent>;
  /** Text only. Provider errors are reported by eventStream and collect(); await collect() to verify success. */
  textStream: AsyncIterable<string>;
  collect: () => Promise<GenerateTextOutput>;
}
