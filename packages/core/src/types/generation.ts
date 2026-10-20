import type { BoundedReplayBroadcastOptions } from "../bounded-broadcast.js";
import type { EgressDeclaration, EgressPolicy } from "../egress-types.js";
import type {
  z,
  ZodTypeAny
} from "zod";
import type {
  AgentApprovalRequest,
  AgentApprovalResolution,
  FinishReason,
  JsonValue,
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
  ToolRuntimeContext,
  ToolSet
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

/**
 * Result of `createRedactionPolicy` or `createLatamSensitiveDataPolicy`.
 * Declared structurally so generation contracts do not import the policy module.
 */
export interface GenerationRedactionPolicy {
  redactText(text: string): string;
  redactJson<T extends JsonValue | undefined>(value: T): T;
  redactMessages(messages: ModelMessage[]): ModelMessage[];
}

/** Option bag accepted by `createRedactionPolicy`. */
export interface GenerationRedactionPolicyOptions {
  rules?: Array<{
    name?: string;
    pattern: RegExp | string;
    replacement?: string | ((match: string) => string);
  }>;
  includeEmails?: boolean;
  replacement?: string;
}

/** Per-channel switches. Every channel defaults to on when a policy is set. */
export interface GenerationRedactionOptions {
  policy?: GenerationRedactionPolicy | GenerationRedactionPolicyOptions;
  /** User and system text. */
  input?: boolean;
  /** Tool-call arguments in provider requests, stream events, and returned transcripts. */
  toolInputs?: boolean;
  /** Tool results before they are stored, streamed, or sent back to the model. */
  toolResults?: boolean;
  /** Assistant text. */
  output?: boolean;
}

export type GenerationRedaction =
  | GenerationRedactionOptions
  | GenerationRedactionPolicy
  | GenerationRedactionPolicyOptions
  | false;

export interface StopConditionContext {
  readonly steps: readonly GenerateTextStep[];
  readonly stepCount: number;
}

/** Return true to stop before the next model call. Tool calls from the current step still run. */
export type StopCondition = (context: StopConditionContext) => boolean | Promise<boolean>;

export interface PrepareStepInfo {
  /** Zero-based index of the model call about to start. */
  readonly stepNumber: number;
  /** One-based index shared with onBeforeModelStep. */
  readonly step: number;
  readonly steps: readonly GenerateTextStep[];
  readonly model: LanguageModel;
  readonly messages: readonly ModelMessage[];
  readonly tools?: ToolSet;
}

export interface PrepareStepResult {
  model?: LanguageModel | string;
  tools?: ToolCollection;
  toolChoice?: ToolChoice;
  system?: string;
  messages?: ModelMessage[];
  activeTools?: readonly string[];
}

export interface GenerateOutputOption {
  readonly type: "text" | "object";
  readonly schema?: import("zod").ZodTypeAny;
  readonly name?: string;
  readonly description?: string;
  readonly mode?: StructuredOutputMode;
}

export type GenerateTextOptions<
  TModel extends LanguageModel = LanguageModel,
  TContext = unknown
> = RetryOptions &
  GenerateInputSource & {
    /** Language model, or a `provider/model` string resolved by `modelResolver` or `registerModelProvider`. */
    model: TModel | string;
    /** Instance-local resolver used when `model` is a string. Wins over the process registry. */
    modelResolver?: { model(identifier: string): TModel };
    system?: string;
    tools?: ToolCollection;
    /** Names of tools the model may see for this call. Other registered tools are omitted. */
    activeTools?: readonly string[];
    /** Stops the loop when any condition returns true. Omission keeps the maxSteps default of 1. */
    stopWhen?: StopCondition | readonly StopCondition[];
    /** Per-step override of model, tools, system, or messages. Applies to that step only unless messages are replaced. */
    prepareStep?: (context: PrepareStepInfo) => PrepareStepResult | undefined | Promise<PrepareStepResult | undefined>;
    /** `Output.text()` or `Output.object({ schema })`. Tools may be set in the same call. */
    output?: GenerateOutputOption;
    toolChoice?: ToolChoice;
    toolExecution?: ToolExecutionOptions;
    toolApprovalPolicy?: ToolApprovalPolicy<TContext>;
    toolApprovalSigner?: ToolApprovalSigner;
    /** Resolved local approvals supplied by a durable agent runtime. */
    toolApprovalResolutions?: AgentApprovalResolution[];
    toolContext?: ToolRuntimeContext<TContext>;
    /**
     * Application context forwarded to `tool.execute` as `context.context`
     * when `toolContext.context` is omitted.
     */
    toolsContext?: TContext;
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
    /** Positive safe integer, or explicit "unlimited" opt-in. Defaults to 1. */
    maxSteps?: number | "unlimited";
    /** Streaming replay/queue limits. Full replay with overflow errors is the default. */
    streamBuffer?: BoundedReplayBroadcastOptions;
    temperature?: number;
    topP?: number;
    seed?: number;
    stopSequences?: readonly string[];
    maxTokens?: number;
    reasoning?: ReasoningConfig;
    providerOptions?: ProviderOptionsOf<TModel>;
    structuredOutput?: StructuredOutputConfig;
    /**
     * Experimental public beta. Fail closed before the provider call.
     * The caller declares `egress.region` and `egress.endpoint`; adapters do not reveal a private base URL.
     */
    egressPolicy?: EgressPolicy;
    /** Region and endpoint for this call. A conflict with the model or provider options is denied. */
    egress?: EgressDeclaration;
    /** `false` leaves text, tool arguments, and tool results unchanged. */
    redaction?: GenerationRedaction;
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
  /** Present when `output` is set and the call produced a terminal result. */
  output?: unknown;
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
  /** Cooperatively abort generation. Custom result implementations may omit this hook. */
  cancel?: (reason?: unknown) => void;
  eventStream: AsyncIterable<ObjectStreamEvent<z.infer<TSchema>, Partial<z.infer<TSchema>>>>;
  partialObjectStream: AsyncIterable<Partial<z.infer<TSchema>>>;
  /** Text only. Provider errors are reported by eventStream and collect(); await collect() to verify success. */
  textStream: AsyncIterable<string>;
  collect: () => Promise<GenerateObjectOutput<TSchema>>;
}

export interface StreamTextResult {
  /** Cooperatively abort generation. Custom result implementations may omit this hook. */
  cancel?: (reason?: unknown) => void;
  eventStream: AsyncIterable<StreamEvent>;
  /** Text only. Provider errors are reported by eventStream and collect(); await collect() to verify success. */
  textStream: AsyncIterable<string>;
  collect: () => Promise<GenerateTextOutput>;
}
