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

export interface ProviderDataPart {
  type: "provider-data";
  provider: string;
  data: JsonValue;
}

export type ContentPart = TextPart | ImagePart | FilePart | ToolCallPart | ToolResultPart | ProviderDataPart;

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
  realtime?: {
    sessions: boolean;
    audioInput: boolean;
    audioOutput: boolean;
    tools: boolean;
    browserTokens: boolean;
  };
  agentCapabilities?: AgentCapabilities;
}

export interface AgentCapabilities {
  supportTier: AgentSupportTier;
  toolChoiceNone: boolean;
  approvalRequests: boolean;
  hostedWebSearch: boolean;
  hostedFileSearch: boolean;
  remoteMcp: boolean;
  computerUse: boolean;
  codeExecution: boolean;
  toolsets: boolean;
}

export type AgentSupportTier = "tier-a" | "tier-b" | "tier-c";

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

export interface StreamProviderDataEvent {
  type: "provider-data";
  provider: string;
  data: JsonValue;
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
  | StreamProviderDataEvent
  | StreamFinishEvent
  | StreamErrorEvent;

export interface AgentRunStartEvent {
  type: "agent-run-start";
  currentStep: number;
  maxSteps: number;
}

export interface AgentStepStartEvent {
  type: "agent-step-start";
  stepIndex: number;
}

export interface AgentStepFinishEvent {
  type: "agent-step-finish";
  step: AgentStep;
}

export interface AgentApprovalRequestEvent {
  type: "agent-approval-request";
  approval: AgentApprovalRequest;
}

export interface AgentApprovalResolvedEvent {
  type: "agent-approval-resolved";
  approval: AgentApprovalResponse;
}

export interface AgentRunFinishEvent {
  type: "agent-run-finish";
  status: AgentStatus;
  state: AgentRunState;
}

export type AgentStreamEvent =
  | StreamEvent
  | AgentRunStartEvent
  | AgentStepStartEvent
  | AgentStepFinishEvent
  | AgentApprovalRequestEvent
  | AgentApprovalResolvedEvent
  | AgentRunFinishEvent;

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

export interface AudioFrame {
  data: string | Uint8Array | ArrayBuffer;
  mediaType: string;
  sampleRateHz?: number;
  channels?: number;
  isFinal?: boolean;
}

export interface RealtimeConnectOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  subprotocols?: string[];
}

export interface RealtimeSessionConfig {
  instructions?: string;
  voice?: string;
  tools?: ToolCollection;
  toolChoice?: ToolChoice;
  inputAudioMediaType?: string;
  outputAudioMediaType?: string;
  inputSampleRateHz?: number;
  outputSampleRateHz?: number;
  channels?: number;
  turnDetection?: Record<string, unknown> | null;
  providerOptions?: ProviderOptions;
  metadata?: Record<string, JsonValue>;
  autoResponse?: boolean;
}

export interface RealtimeTokenResult {
  value: string;
  expiresAtMs?: number;
  rawResponse?: unknown;
}

export interface RealtimeSessionStartedEvent {
  type: "realtime-start";
  sessionId?: string;
  providerMetadata?: Record<string, JsonValue>;
}

export interface RealtimeTextDeltaEvent {
  type: "realtime-text-delta";
  textDelta: string;
  itemId?: string;
  responseId?: string;
  role?: "assistant";
  providerMetadata?: Record<string, JsonValue>;
}

export interface RealtimeAudioOutputEvent {
  type: "realtime-audio-output";
  audio: Uint8Array;
  mediaType: string;
  sampleRateHz?: number;
  channels?: number;
  itemId?: string;
  responseId?: string;
  providerMetadata?: Record<string, JsonValue>;
}

export interface RealtimeTranscriptEvent {
  type: "realtime-transcript";
  text: string;
  role: "user" | "assistant";
  isFinal: boolean;
  itemId?: string;
  responseId?: string;
  providerMetadata?: Record<string, JsonValue>;
}

export interface RealtimeToolCallEvent {
  type: "realtime-tool-call";
  toolCall: ToolCall;
}

export interface RealtimeToolResultEvent {
  type: "realtime-tool-result";
  toolResult: ToolExecutionResult;
}

export interface RealtimeResponseCompleteEvent {
  type: "realtime-response-complete";
  reason?: string;
  providerMetadata?: Record<string, JsonValue>;
}

export interface RealtimeSessionResumptionEvent {
  type: "realtime-session-resumption";
  handle?: string;
  resumable?: boolean;
  providerMetadata?: Record<string, JsonValue>;
}

export interface RealtimeGoAwayEvent {
  type: "realtime-go-away";
  timeLeftMs?: number;
  providerMetadata?: Record<string, JsonValue>;
}

export interface RealtimeSessionEndedEvent {
  type: "realtime-end";
  reason?: string;
  providerMetadata?: Record<string, JsonValue>;
}

export interface RealtimeErrorEvent {
  type: "realtime-error";
  error?: Error;
  message?: string;
  providerMetadata?: Record<string, JsonValue>;
}

export type RealtimeEvent =
  | RealtimeSessionStartedEvent
  | RealtimeTextDeltaEvent
  | RealtimeAudioOutputEvent
  | RealtimeTranscriptEvent
  | RealtimeToolCallEvent
  | RealtimeToolResultEvent
  | RealtimeResponseCompleteEvent
  | RealtimeSessionResumptionEvent
  | RealtimeGoAwayEvent
  | RealtimeSessionEndedEvent
  | RealtimeErrorEvent;

export interface RealtimeSession {
  readonly provider: string;
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;
  readonly config: RealtimeSessionConfig;
  sendAudio(frame: AudioFrame): Promise<void>;
  sendText(text: string): Promise<void>;
  sendToolResult(result: ToolExecutionResult): Promise<void>;
  update(config: Partial<RealtimeSessionConfig>): Promise<void>;
  eventStream(): AsyncIterable<RealtimeEvent>;
  close(): Promise<void>;
}

export interface RealtimeModel {
  readonly provider: string;
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;
  connect(config?: RealtimeSessionConfig, options?: RealtimeConnectOptions): Promise<RealtimeSession>;
  createBrowserToken?(config?: RealtimeSessionConfig, options?: RealtimeConnectOptions): Promise<RealtimeTokenResult>;
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
  realtimeModel?: (modelId: string) => RealtimeModel;
  groundedLanguageModel?: (modelId: string) => GroundedLanguageModel;
}

export type CallableProviderAdapter = ProviderAdapter & ((modelId: string) => LanguageModel);

export interface ToolDefinition<TSchema extends ZodTypeAny = ZodTypeAny, TResult = JsonValue> {
  name: string;
  description?: string;
  schema: TSchema;
  metadata?: Record<string, JsonValue>;
  requiresApproval?: boolean;
  execute: (input: z.infer<TSchema>) => Promise<TResult> | TResult;
}

export type HostedToolClass =
  | "web-search"
  | "file-search"
  | "remote-mcp"
  | "computer-use"
  | "code-execution"
  | "toolset"
  | "custom";

export interface HostedToolDefinition<TConfig extends JsonValue = JsonValue> {
  kind: "hosted";
  name: string;
  provider?: string;
  type: string;
  config?: TConfig;
  toolClass?: HostedToolClass;
  requiresApproval?: boolean;
  metadata?: Record<string, JsonValue>;
}

export type AnyToolDefinition = ToolDefinition | HostedToolDefinition;

export type ToolSet = Record<string, AnyToolDefinition>;

export interface ToolRegistryLike {
  get(name: string): AnyToolDefinition | undefined;
  has(name: string): boolean;
  entries(): Iterable<[string, AnyToolDefinition]>;
  toToolSet(): ToolSet;
}

export type ToolCollection = ToolSet | ToolRegistryLike;

export interface ToolApprovalRequest {
  toolCall: ToolCall;
  tool: ToolDefinition;
  input: JsonValue;
  step: number;
  model: LanguageModel | RealtimeModel;
  request?: ModelGenerateInput;
  realtimeConfig?: RealtimeSessionConfig;
}

export interface ToolApprovalDecision {
  approved: boolean;
  reason?: string;
  metadata?: Record<string, JsonValue>;
}

export interface ToolApprovalEvent {
  request: ToolApprovalRequest;
  decision: ToolApprovalDecision;
}

export type ToolApprovalPolicy = (
  request: ToolApprovalRequest
) => ToolApprovalDecision | boolean | Promise<ToolApprovalDecision | boolean>;

export type ToolApprovalObserver = (
  event: ToolApprovalEvent
) => void | Promise<void>;

export type ProviderOptionsOf<TModel extends LanguageModel> = TModel extends LanguageModel<infer TProviderOptions>
  ? TProviderOptions
  : ProviderOptions;

export type GenerateTextOptions<TModel extends LanguageModel = LanguageModel> = RetryOptions &
  GenerateInputSource & {
    model: TModel;
    system?: string;
    tools?: ToolCollection;
    toolChoice?: ToolChoice;
    toolExecution?: ToolExecutionOptions;
    toolApprovalPolicy?: ToolApprovalPolicy;
    onToolApprovalDecision?: ToolApprovalObserver;
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

export type AgentStatus = "running" | "completed" | "suspended" | "failed" | "cancelled";

export type AgentStepStatus = "running" | "completed" | "suspended" | "failed";

export interface AgentStepRequest {
  messages: ModelMessage[];
  toolChoice?: ToolChoice;
  toolExecution?: ToolExecutionOptions;
  temperature?: number;
  maxTokens?: number;
  reasoning?: ReasoningConfig;
  providerOptions?: ProviderOptions;
  timeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
}

export interface AgentStepResponse {
  messages: ModelMessage[];
  text?: string;
  finishReason?: FinishReason;
  providerFinishReason?: string;
  usage?: TokenUsage;
}

export interface AgentStep {
  index: number;
  status: AgentStepStatus;
  startedAt?: number;
  finishedAt?: number;
  request: AgentStepRequest;
  response?: AgentStepResponse;
  toolResults: ToolExecutionResult[];
  error?: {
    message: string;
  };
}

export interface AgentRunState {
  runId: string;
  agentId?: string;
  parentRunId?: string;
  provider: string;
  modelId: string;
  status: AgentStatus;
  messages: ModelMessage[];
  steps: AgentStep[];
  toolResults: ToolExecutionResult[];
  currentStep: number;
  maxSteps: number;
  outputText: string;
  finishReason?: FinishReason;
  providerFinishReason?: string;
  usage?: TokenUsage;
  pendingApprovals: AgentApprovalRequest[];
  metadata?: Record<string, JsonValue>;
  handoff?: AgentHandoff;
  startedAt?: number;
  updatedAt?: number;
  error?: {
    message: string;
  };
}

export interface AgentRunStore {
  load(runId: string): Promise<AgentRunState | undefined> | AgentRunState | undefined;
  save(state: AgentRunState): Promise<void> | void;
  delete?(runId: string): Promise<void> | void;
}

export interface AgentMemoryContext {
  runId: string;
  agentId?: string;
  state?: AgentRunState;
  metadata?: Record<string, JsonValue>;
}

export interface AgentMemoryStore {
  load(context: AgentMemoryContext): Promise<ModelMessage[]> | ModelMessage[];
  save?(context: AgentMemoryContext & { state: AgentRunState }): Promise<void> | void;
}

export interface SqliteStatementLike<TResult extends Record<string, unknown> = Record<string, unknown>> {
  run(params?: readonly unknown[] | Record<string, unknown>): unknown;
  get(params?: readonly unknown[] | Record<string, unknown>): TResult | undefined;
}

export interface SqliteDatabaseLike {
  exec(sql: string): unknown;
  prepare?<TResult extends Record<string, unknown> = Record<string, unknown>>(sql: string): SqliteStatementLike<TResult>;
  query?<TResult extends Record<string, unknown> = Record<string, unknown>>(sql: string): SqliteStatementLike<TResult>;
}

export interface SqliteAgentRunStoreOptions {
  db: SqliteDatabaseLike;
  tableName?: string;
}

export interface SqliteAgentMemoryStoreOptions {
  db: SqliteDatabaseLike;
  tableName?: string;
  key?: (context: AgentMemoryContext) => string;
  selectMessages?: (state: AgentRunState) => ModelMessage[];
}

export interface PostgresQueryResultLike<TResult extends Record<string, unknown> = Record<string, unknown>> {
  rows: TResult[];
}

export interface PostgresClientLike {
  query<TResult extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<PostgresQueryResultLike<TResult>> | PostgresQueryResultLike<TResult>;
}

export interface PostgresAgentRunStoreOptions {
  client: PostgresClientLike;
  tableName?: string;
}

export interface PostgresAgentMemoryStoreOptions {
  client: PostgresClientLike;
  tableName?: string;
  key?: (context: AgentMemoryContext) => string;
  selectMessages?: (state: AgentRunState) => ModelMessage[];
}

export interface AgentHandoff {
  id: string;
  fromRunId: string;
  fromAgentId?: string;
  toAgentId?: string;
  summary: string;
  contextMessages: ModelMessage[];
  metadata?: Record<string, JsonValue>;
}

export interface AgentTelemetryRunStartEvent {
  type: "run-start";
  runId: string;
  agentId?: string;
  provider: string;
  modelId: string;
  maxSteps: number;
}

export interface AgentTelemetryStepStartEvent {
  type: "step-start";
  runId: string;
  agentId?: string;
  stepIndex: number;
}

export interface AgentTelemetryStepFinishEvent {
  type: "step-finish";
  runId: string;
  agentId?: string;
  step: AgentStep;
}

export interface AgentTelemetryApprovalRequestEvent {
  type: "approval-request";
  runId: string;
  agentId?: string;
  approval: AgentApprovalRequest;
}

export interface AgentTelemetryApprovalResolvedEvent {
  type: "approval-resolved";
  runId: string;
  agentId?: string;
  approval: AgentApprovalResponse;
}

export interface AgentTelemetryToolApprovalEvent {
  type: "tool-approval";
  runId: string;
  agentId?: string;
  toolCall: ToolCall;
  approved: boolean;
  reason?: string;
  metadata?: Record<string, JsonValue>;
}

export interface AgentTelemetryMemoryLoadedEvent {
  type: "memory-loaded";
  runId: string;
  agentId?: string;
  messageCount: number;
}

export interface AgentGuardrailTrigger {
  triggered: true;
  reason?: string;
  metadata?: Record<string, JsonValue>;
}

export interface AgentInputGuardrailRequest {
  runId: string;
  agentId?: string;
  messages: ModelMessage[];
  metadata?: Record<string, JsonValue>;
}

export interface AgentOutputGuardrailRequest {
  runId: string;
  agentId?: string;
  state: AgentRunState;
  output: AgentRunOutput | LiveAgentRunOutput;
  metadata?: Record<string, JsonValue>;
}

export type AgentInputGuardrail = (
  request: AgentInputGuardrailRequest
) => AgentGuardrailTrigger | void | Promise<AgentGuardrailTrigger | void>;

export type AgentOutputGuardrail = (
  request: AgentOutputGuardrailRequest
) => AgentGuardrailTrigger | void | Promise<AgentGuardrailTrigger | void>;

export interface AgentTelemetryGuardrailTriggeredEvent {
  type: "guardrail-triggered";
  runId: string;
  agentId?: string;
  stage: "input" | "output";
  reason?: string;
  metadata?: Record<string, JsonValue>;
}

export interface AgentTelemetryStateSavedEvent {
  type: "state-saved";
  runId: string;
  agentId?: string;
  status: AgentStatus;
}

export interface AgentTelemetryHandoffEvent {
  type: "handoff";
  runId: string;
  agentId?: string;
  handoff: AgentHandoff;
}

export interface AgentTelemetryRunFinishEvent {
  type: "run-finish";
  runId: string;
  agentId?: string;
  status: AgentStatus;
  state: AgentRunState;
}

export type AgentTelemetryEvent =
  | AgentTelemetryRunStartEvent
  | AgentTelemetryStepStartEvent
  | AgentTelemetryStepFinishEvent
  | AgentTelemetryApprovalRequestEvent
  | AgentTelemetryApprovalResolvedEvent
  | AgentTelemetryToolApprovalEvent
  | AgentTelemetryMemoryLoadedEvent
  | AgentTelemetryGuardrailTriggeredEvent
  | AgentTelemetryStateSavedEvent
  | AgentTelemetryHandoffEvent
  | AgentTelemetryRunFinishEvent;

export type AgentTelemetryObserver = (
  event: AgentTelemetryEvent
) => void | Promise<void>;

export interface AgentDefinition<TModel extends LanguageModel = LanguageModel> {
  id?: string;
  model: TModel;
  instructions?: string;
  tools?: ToolCollection;
  maxSteps?: number;
  temperature?: number;
  maxTokens?: number;
  reasoning?: ReasoningConfig;
  toolExecution?: ToolExecutionOptions;
  toolApprovalPolicy?: ToolApprovalPolicy;
  inputGuardrails?: AgentInputGuardrail[];
  outputGuardrails?: AgentOutputGuardrail[];
  providerOptions?: ProviderOptionsOf<TModel>;
  metadata?: Record<string, JsonValue>;
  store?: AgentRunStore;
  memory?: AgentMemoryStore;
  onTelemetryEvent?: AgentTelemetryObserver;
}

export interface LiveAgentDefinition<TModel extends RealtimeModel = RealtimeModel> {
  id?: string;
  model: TModel;
  instructions?: string;
  tools?: ToolCollection;
  toolChoice?: ToolChoice;
  toolExecution?: ToolExecutionOptions;
  toolApprovalPolicy?: ToolApprovalPolicy;
  inputGuardrails?: AgentInputGuardrail[];
  outputGuardrails?: AgentOutputGuardrail[];
  providerOptions?: ProviderOptions;
  metadata?: Record<string, JsonValue>;
  store?: AgentRunStore;
  memory?: AgentMemoryStore;
  onTelemetryEvent?: AgentTelemetryObserver;
}

export interface AgentApprovalRequest {
  provider: string;
  id: string;
  name: string;
  arguments: string;
  serverLabel?: string;
  rawData: JsonValue;
}

export interface AgentApprovalResponse {
  provider: string;
  approvalRequestId: string;
  approve: boolean;
  id?: string;
  reason?: string;
}

export type AgentRunInput<TModel extends LanguageModel = LanguageModel> = RetryOptions &
  GenerateInputSource & {
    runId?: string;
    state?: AgentRunState;
    approvals?: AgentApprovalResponse[];
    handoff?: AgentHandoff;
    system?: string;
    tools?: ToolCollection;
    toolChoice?: ToolChoice;
    toolExecution?: ToolExecutionOptions;
    toolApprovalPolicy?: ToolApprovalPolicy;
    maxSteps?: number;
    temperature?: number;
    maxTokens?: number;
    reasoning?: ReasoningConfig;
    providerOptions?: ProviderOptionsOf<TModel>;
    metadata?: Record<string, JsonValue>;
  };

export interface AgentRunOutput {
  status: AgentStatus;
  outputText: string;
  finishReason?: FinishReason;
  providerFinishReason?: string;
  usage?: TokenUsage;
  messages: ModelMessage[];
  steps: AgentStep[];
  toolResults: ToolExecutionResult[];
  state: AgentRunState;
  error?: {
    message: string;
  };
}

export type LiveAgentRunInput = GenerateInputSource &
  RetryOptions & {
    runId?: string;
    system?: string;
    tools?: ToolCollection;
    toolChoice?: ToolChoice;
    toolExecution?: ToolExecutionOptions;
    toolApprovalPolicy?: ToolApprovalPolicy;
    providerOptions?: ProviderOptions;
    metadata?: Record<string, JsonValue>;
    realtime?: RealtimeSessionConfig;
    connectOptions?: RealtimeConnectOptions;
  };

export interface LiveAgentRunOutput {
  status: AgentStatus;
  outputText: string;
  messages: ModelMessage[];
  toolResults: ToolExecutionResult[];
  state: AgentRunState;
  error?: {
    message: string;
  };
}

export interface AgentStreamResult {
  eventStream: AsyncIterable<AgentStreamEvent>;
  textStream: AsyncIterable<string>;
  collect: () => Promise<AgentRunOutput>;
}

export type AgentLiveEvent = AgentStreamEvent | RealtimeEvent;

export interface AgentLiveStreamResult {
  eventStream: AsyncIterable<AgentLiveEvent>;
  textStream: AsyncIterable<string>;
  session: Promise<RealtimeSession>;
  collect: () => Promise<LiveAgentRunOutput>;
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

export interface UIMessageProviderDataChunk {
  type: "provider-data";
  messageId: string;
  role: "assistant";
  provider: string;
  data: JsonValue;
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

export interface UIAgentRunStartChunk {
  type: "agent-run-start";
  currentStep: number;
  maxSteps: number;
}

export interface UIAgentStepStartChunk {
  type: "agent-step-start";
  stepIndex: number;
}

export interface UIAgentStepFinishChunk {
  type: "agent-step-finish";
  step: AgentStep;
}

export interface UIAgentApprovalRequestChunk {
  type: "agent-approval-request";
  approval: AgentApprovalRequest;
}

export interface UIAgentApprovalResolvedChunk {
  type: "agent-approval-resolved";
  approval: AgentApprovalResponse;
}

export interface UIAgentRunFinishChunk {
  type: "agent-run-finish";
  status: AgentStatus;
  state: AgentRunState;
}

export type UIMessageChunk =
  | UIMessageTextChunk
  | UIMessageToolCallChunk
  | UIMessageToolResultChunk
  | UIMessageProviderDataChunk
  | UIMessageFinishChunk
  | UIMessageErrorChunk
  | UIAgentRunStartChunk
  | UIAgentStepStartChunk
  | UIAgentStepFinishChunk
  | UIAgentApprovalRequestChunk
  | UIAgentApprovalResolvedChunk
  | UIAgentRunFinishChunk;

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
