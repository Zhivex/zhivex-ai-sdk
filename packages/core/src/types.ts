import type { z, ZodTypeAny } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type PartialJsonValue =
  | JsonPrimitive
  | PartialJsonValue[]
  | {
      [key: string]: PartialJsonValue | undefined;
    };

export type MessageRole = "system" | "user" | "assistant" | "tool";
export type FinishReason = "stop" | "length" | "tool-calls" | "content-filter" | "error" | "unknown";
export type StructuredOutputMode = "auto" | "native" | "prompted";

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  input: JsonValue;
}

export interface ToolExecutionResult {
  toolCallId: string;
  toolName: string;
  output?: JsonValue;
  error?: {
    message: string;
  };
  isError: boolean;
}

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      type: "tool";
      toolName: string;
    };

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image";
  image: string;
  mediaType?: string;
}

export interface FilePart {
  type: "file";
  data: string;
  mediaType: string;
  filename?: string;
}

export interface ToolCallPart {
  type: "tool-call";
  toolCall: ToolCall;
}

export interface ToolResultPart {
  type: "tool-result";
  toolResult: ToolExecutionResult;
}

export type ContentPart = TextPart | ImagePart | FilePart | ToolCallPart | ToolResultPart;

export interface ModelMessage {
  role: MessageRole;
  parts: ContentPart[];
}

export interface ModelCapabilities {
  streaming: boolean;
  tools: boolean;
  structuredOutput: boolean;
  jsonMode: boolean;
  toolChoice: boolean;
  parallelToolCalls: boolean;
  vision: boolean;
  files: boolean;
  audioInput: boolean;
  audioOutput: boolean;
  embeddings: boolean;
  reasoning: boolean;
  webSearch: boolean;
}

export interface RetryOptions {
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
}

export interface ToolExecutionOptions {
  parallel?: boolean;
  maxConcurrency?: number;
  timeoutMs?: number;
  stopOnError?: boolean;
}

export interface StructuredOutputConfig<TSchema extends ZodTypeAny = ZodTypeAny> {
  schema: TSchema;
  mode: StructuredOutputMode;
  name?: string;
  description?: string;
}

export interface ReasoningConfig {
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  budgetTokens?: number;
}

export interface StreamTextDeltaEvent {
  type: "text-delta";
  textDelta: string;
}

export interface StreamToolCallEvent {
  type: "tool-call";
  toolCall: ToolCall;
}

export interface StreamToolResultEvent {
  type: "tool-result";
  toolResult: ToolExecutionResult;
}

export interface StreamFinishEvent {
  type: "finish";
  finishReason?: FinishReason;
  providerFinishReason?: string;
  usage?: TokenUsage;
}

export interface StreamErrorEvent {
  type: "error";
  error: Error;
}

export type StreamEvent =
  | StreamTextDeltaEvent
  | StreamToolCallEvent
  | StreamToolResultEvent
  | StreamFinishEvent
  | StreamErrorEvent;

export interface StreamObjectDeltaEvent {
  type: "object-delta";
  textDelta: string;
  partialText: string;
}

export interface StreamObjectPartialEvent<TObject = PartialJsonValue> {
  type: "object-partial";
  partialObject: TObject;
}

export interface StreamObjectCompleteEvent<TObject = JsonValue> {
  type: "object-complete";
  object: TObject;
}

export type ObjectStreamEvent<TObject = JsonValue, TPartialObject = PartialJsonValue> =
  | StreamEvent
  | StreamObjectDeltaEvent
  | StreamObjectPartialEvent<TPartialObject>
  | StreamObjectCompleteEvent<TObject>;

export interface GenerateResult {
  message?: ModelMessage;
  messages?: ModelMessage[];
  text?: string;
  finishReason?: FinishReason;
  providerFinishReason?: string;
  usage?: TokenUsage;
  rawResponse?: unknown;
}

export interface EmbedResult {
  embeddings: number[][];
  usage?: TokenUsage;
  rawResponse?: unknown;
}

export interface AudioInput {
  data: string | Uint8Array | ArrayBuffer;
  mediaType: string;
  filename?: string;
}

export interface TranscriptionResult {
  text: string;
  rawResponse?: unknown;
}

export interface SpeechResult {
  audio: Uint8Array;
  mediaType: string;
  rawResponse?: unknown;
}

export interface GroundingSource {
  title?: string;
  url: string;
  snippet?: string;
  providerMetadata?: Record<string, unknown>;
}

export interface GroundedGenerateResult {
  text: string;
  sources: GroundingSource[];
  finishReason?: FinishReason;
  providerFinishReason?: string;
  usage?: TokenUsage;
  rawResponse?: unknown;
}

export type GenerateInputSource =
  | {
      prompt: string;
      messages?: never;
    }
  | {
      prompt?: never;
      messages: ModelMessage[];
    }
  | {
      prompt?: undefined;
      messages?: undefined;
    };

export type ProviderOptions = Record<string, unknown>;

export interface ModelGenerateInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  messages: ModelMessage[];
  tools?: ToolSet;
  toolChoice?: ToolChoice;
  toolExecution?: ToolExecutionOptions;
  temperature?: number;
  maxTokens?: number;
  reasoning?: ReasoningConfig;
  providerOptions?: TProviderOptions;
  structuredOutput?: StructuredOutputConfig;
}

export interface TranscriptionModelInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  audio: AudioInput;
  prompt?: string;
  language?: string;
  providerOptions?: TProviderOptions;
}

export interface SpeechModelInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  input: string;
  voice?: string;
  providerOptions?: TProviderOptions;
}

export type GroundedModelGenerateInput<TProviderOptions extends ProviderOptions = ProviderOptions> = RetryOptions &
  GenerateInputSource & {
  system?: string;
  temperature?: number;
  maxTokens?: number;
  reasoning?: ReasoningConfig;
  providerOptions?: TProviderOptions;
};

export interface LanguageModel<TProviderOptions extends ProviderOptions = ProviderOptions> {
  readonly provider: string;
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;
  generate(input: ModelGenerateInput<TProviderOptions>): Promise<GenerateResult>;
  stream?(input: ModelGenerateInput<TProviderOptions>): Promise<AsyncIterable<StreamEvent>>;
}

export interface TranscriptionModel<TProviderOptions extends ProviderOptions = ProviderOptions> {
  readonly provider: string;
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;
  transcribe(input: TranscriptionModelInput<TProviderOptions>): Promise<TranscriptionResult>;
}

export interface SpeechModel<TProviderOptions extends ProviderOptions = ProviderOptions> {
  readonly provider: string;
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;
  generateSpeech(input: SpeechModelInput<TProviderOptions>): Promise<SpeechResult>;
}

export interface GroundedLanguageModel<TProviderOptions extends ProviderOptions = ProviderOptions> {
  readonly provider: string;
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;
  generate(input: GroundedModelGenerateInput<TProviderOptions>): Promise<GroundedGenerateResult>;
}

export interface EmbeddingModel {
  readonly provider: string;
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;
  embed(input: EmbedInput & RetryOptions): Promise<EmbedResult>;
}

export interface ProviderAdapter {
  readonly name: string;
  languageModel(modelId: string): LanguageModel;
  embeddingModel?: (modelId: string) => EmbeddingModel;
  transcriptionModel?: (modelId: string) => TranscriptionModel;
  speechModel?: (modelId: string) => SpeechModel;
  groundedLanguageModel?: (modelId: string) => GroundedLanguageModel;
}

export type CallableProviderAdapter = ProviderAdapter & ((modelId: string) => LanguageModel);

export interface ToolDefinition<TSchema extends ZodTypeAny = ZodTypeAny, TResult = JsonValue> {
  name: string;
  description?: string;
  schema: TSchema;
  execute: (input: z.infer<TSchema>) => Promise<TResult> | TResult;
}

export type ToolSet = Record<string, ToolDefinition>;

export type ProviderOptionsOf<TModel extends LanguageModel> = TModel extends LanguageModel<infer TProviderOptions>
  ? TProviderOptions
  : ProviderOptions;

export type GenerateTextOptions<TModel extends LanguageModel = LanguageModel> = RetryOptions &
  GenerateInputSource & {
    model: TModel;
    system?: string;
    tools?: ToolSet;
    toolChoice?: ToolChoice;
    toolExecution?: ToolExecutionOptions;
    maxSteps?: number;
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
}

export type TranscribeAudioOptions<TModel extends TranscriptionModel = TranscriptionModel> = RetryOptions & {
  model: TModel;
  audio: AudioInput;
  prompt?: string;
  language?: string;
  providerOptions?: TModel extends TranscriptionModel<infer TProviderOptions> ? TProviderOptions : ProviderOptions;
};

export interface TranscriptionOutput extends TranscriptionResult {
  audio: AudioInput;
}

export type GenerateSpeechOptions<TModel extends SpeechModel = SpeechModel> = RetryOptions & {
  model: TModel;
  input: string;
  voice?: string;
  providerOptions?: TModel extends SpeechModel<infer TProviderOptions> ? TProviderOptions : ProviderOptions;
};

export interface SpeechOutput extends SpeechResult {
  input: string;
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
  textStream: AsyncIterable<string>;
  collect: () => Promise<GenerateObjectOutput<TSchema>>;
}

export interface StreamTextResult {
  eventStream: AsyncIterable<StreamEvent>;
  textStream: AsyncIterable<string>;
  collect: () => Promise<GenerateTextOutput>;
}

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
  model: LanguageModel<TProviderOptions>;
  input: ModelGenerateInput<TProviderOptions>;
  startedAt: number;
}

export interface TelemetryGenerateFinishEvent<TProviderOptions extends ProviderOptions = ProviderOptions> {
  type: "generate-finish";
  model: LanguageModel<TProviderOptions>;
  input: ModelGenerateInput<TProviderOptions>;
  output: GenerateResult;
  startedAt: number;
  finishedAt: number;
  latencyMs: number;
}

export interface TelemetryGenerateErrorEvent<TProviderOptions extends ProviderOptions = ProviderOptions> {
  type: "generate-error";
  model: LanguageModel<TProviderOptions>;
  input: ModelGenerateInput<TProviderOptions>;
  error: Error;
  startedAt: number;
  finishedAt: number;
  latencyMs: number;
}

export interface TelemetryStreamStartEvent<TProviderOptions extends ProviderOptions = ProviderOptions> {
  type: "stream-start";
  model: LanguageModel<TProviderOptions>;
  input: ModelGenerateInput<TProviderOptions>;
  startedAt: number;
}

export interface TelemetryStreamFinishEvent<TProviderOptions extends ProviderOptions = ProviderOptions> {
  type: "stream-finish";
  model: LanguageModel<TProviderOptions>;
  input: ModelGenerateInput<TProviderOptions>;
  startedAt: number;
  finishedAt: number;
  latencyMs: number;
  finishReason?: FinishReason;
  providerFinishReason?: string;
  usage?: TokenUsage;
}

export interface TelemetryStreamErrorEvent<TProviderOptions extends ProviderOptions = ProviderOptions> {
  type: "stream-error";
  model: LanguageModel<TProviderOptions>;
  input: ModelGenerateInput<TProviderOptions>;
  error: Error;
  startedAt: number;
  finishedAt: number;
  latencyMs: number;
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
  | TelemetryStreamFinishEvent<TProviderOptions>
  | TelemetryStreamErrorEvent<TProviderOptions>
  | TelemetryToolExecutionStartEvent<TProviderOptions>
  | TelemetryToolExecutionFinishEvent<TProviderOptions>
  | TelemetryToolExecutionErrorEvent<TProviderOptions>;

export interface UIMessage {
  id: string;
  role: MessageRole;
  parts: ContentPart[];
}

export interface UIMessageTextChunk {
  type: "text-delta";
  messageId: string;
  role: "assistant";
  textDelta: string;
}

export interface UIMessageToolCallChunk {
  type: "tool-call";
  messageId: string;
  role: "assistant";
  toolCall: ToolCall;
}

export interface UIMessageToolResultChunk {
  type: "tool-result";
  messageId: string;
  role: "tool";
  toolResult: ToolExecutionResult;
}

export interface UIMessageFinishChunk {
  type: "finish";
  messageId: string;
  finishReason?: FinishReason;
  providerFinishReason?: string;
  usage?: TokenUsage;
}

export interface UIMessageErrorChunk {
  type: "error";
  messageId: string;
  error: {
    message: string;
  };
}

export type UIMessageChunk =
  | UIMessageTextChunk
  | UIMessageToolCallChunk
  | UIMessageToolResultChunk
  | UIMessageFinishChunk
  | UIMessageErrorChunk;

export interface EmbedInput {
  values: string[];
}

export interface EmbedOptions extends RetryOptions {
  model: EmbeddingModel;
  value: string | string[];
}

export interface EmbedOutput extends EmbedResult {
  values: string[];
}
