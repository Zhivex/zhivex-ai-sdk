import type {
  FinishReason,
  ProviderOptions,
  TokenUsage
} from "./common.js";
import type {
  ToolCall,
  ToolExecutionResult
} from "./messages.js";
import type {
  LanguageModel,
  ModelGenerateInput
} from "./model-tools.js";
import type {
  GenerateResult,
  StreamEvent
} from "./stream.js";

export interface LanguageModelMiddlewareContext<TProviderOptions extends ProviderOptions = ProviderOptions> {
  model: LanguageModel<TProviderOptions>;
  input: ModelGenerateInput<TProviderOptions>;
}

export interface LanguageModelMiddlewareNext<TProviderOptions extends ProviderOptions = ProviderOptions> {
  (): Promise<GenerateResult>;
}

export interface LanguageModelStreamMiddlewareContext<TProviderOptions extends ProviderOptions = ProviderOptions> {
  model: LanguageModel<TProviderOptions>;
  input: ModelGenerateInput<TProviderOptions>;
}

export interface LanguageModelStreamMiddlewareNext<TProviderOptions extends ProviderOptions = ProviderOptions> {
  (): Promise<AsyncIterable<StreamEvent>>;
}

export interface LanguageModelMiddleware<TProviderOptions extends ProviderOptions = ProviderOptions> {
  name?: string;
  wrapGenerate?: (
    context: LanguageModelMiddlewareContext<TProviderOptions>,
    next: LanguageModelMiddlewareNext<TProviderOptions>
  ) => Promise<GenerateResult>;
  wrapStream?: (
    context: LanguageModelStreamMiddlewareContext<TProviderOptions>,
    next: LanguageModelStreamMiddlewareNext<TProviderOptions>
  ) => Promise<AsyncIterable<StreamEvent>>;
}

export interface CircuitBreakerState {
  failures: number;
  openedAt?: number;
}

export interface TelemetryGenerateStartEvent<TProviderOptions extends ProviderOptions = ProviderOptions> {
  type: "generate-start";
  generateId?: number;
  model: LanguageModel<TProviderOptions>;
  input: ModelGenerateInput<TProviderOptions>;
  startedAt: number;
}

export interface TelemetryGenerateFinishEvent<TProviderOptions extends ProviderOptions = ProviderOptions> {
  type: "generate-finish";
  generateId?: number;
  model: LanguageModel<TProviderOptions>;
  input: ModelGenerateInput<TProviderOptions>;
  output: GenerateResult;
  startedAt: number;
  finishedAt: number;
  latencyMs: number;
}

export interface TelemetryGenerateErrorEvent<TProviderOptions extends ProviderOptions = ProviderOptions> {
  type: "generate-error";
  generateId?: number;
  model: LanguageModel<TProviderOptions>;
  input: ModelGenerateInput<TProviderOptions>;
  error: Error;
  startedAt: number;
  finishedAt: number;
  latencyMs: number;
}

export interface TelemetryStreamStartEvent<TProviderOptions extends ProviderOptions = ProviderOptions> {
  type: "stream-start";
  streamId?: number;
  model: LanguageModel<TProviderOptions>;
  input: ModelGenerateInput<TProviderOptions>;
  startedAt: number;
}

/** Timing-only signal for one logical non-terminal stream chunk; never includes model output content. */
export interface TelemetryStreamChunkEvent<TProviderOptions extends ProviderOptions = ProviderOptions> {
  type: "stream-chunk";
  streamId?: number;
  model: LanguageModel<TProviderOptions>;
  input: ModelGenerateInput<TProviderOptions>;
  startedAt: number;
  chunkAt: number;
  chunkIndex: number;
  timeToFirstChunkMs?: number;
  timeSincePreviousChunkMs?: number;
}

export interface TelemetryStreamFinishEvent<TProviderOptions extends ProviderOptions = ProviderOptions> {
  type: "stream-finish";
  streamId?: number;
  model: LanguageModel<TProviderOptions>;
  input: ModelGenerateInput<TProviderOptions>;
  startedAt: number;
  finishedAt: number;
  latencyMs: number;
  finishReason?: FinishReason;
  providerFinishReason?: string;
  usage?: TokenUsage;
  /** Number of non-terminal output chunks observed. */
  outputChunkCount?: number;
}

export interface TelemetryStreamErrorEvent<TProviderOptions extends ProviderOptions = ProviderOptions> {
  type: "stream-error";
  streamId?: number;
  model: LanguageModel<TProviderOptions>;
  input: ModelGenerateInput<TProviderOptions>;
  error: Error;
  startedAt: number;
  finishedAt: number;
  latencyMs: number;
  outputChunkCount?: number;
}

export interface TelemetryToolExecutionStartEvent<TProviderOptions extends ProviderOptions = ProviderOptions> {
  type: "tool-execution-start";
  model: LanguageModel<TProviderOptions>;
  input: ModelGenerateInput<TProviderOptions>;
  step: number;
  toolCall: ToolCall;
  startedAt: number;
}

export interface TelemetryToolExecutionFinishEvent<TProviderOptions extends ProviderOptions = ProviderOptions> {
  type: "tool-execution-finish";
  model: LanguageModel<TProviderOptions>;
  input: ModelGenerateInput<TProviderOptions>;
  step: number;
  toolCall: ToolCall;
  toolResult: ToolExecutionResult;
  startedAt: number;
  finishedAt: number;
  latencyMs: number;
}

export interface TelemetryToolExecutionErrorEvent<TProviderOptions extends ProviderOptions = ProviderOptions> {
  type: "tool-execution-error";
  model: LanguageModel<TProviderOptions>;
  input: ModelGenerateInput<TProviderOptions>;
  step: number;
  toolCall: ToolCall;
  error: Error;
  startedAt: number;
  finishedAt: number;
  latencyMs: number;
}

export type LanguageModelTelemetryEvent<TProviderOptions extends ProviderOptions = ProviderOptions> =
  | TelemetryGenerateStartEvent<TProviderOptions>
  | TelemetryGenerateFinishEvent<TProviderOptions>
  | TelemetryGenerateErrorEvent<TProviderOptions>
  | TelemetryStreamStartEvent<TProviderOptions>
  | TelemetryStreamChunkEvent<TProviderOptions>
  | TelemetryStreamFinishEvent<TProviderOptions>
  | TelemetryStreamErrorEvent<TProviderOptions>
  | TelemetryToolExecutionStartEvent<TProviderOptions>
  | TelemetryToolExecutionFinishEvent<TProviderOptions>
  | TelemetryToolExecutionErrorEvent<TProviderOptions>;
