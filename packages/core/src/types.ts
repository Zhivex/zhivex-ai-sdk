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
export type FinishReason = "stop" | "length" | "tool-calls" | "content-filter" | "refusal" | "error" | "unknown";
export type StructuredOutputMode = "auto" | "native" | "prompted";

export interface TokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  speed?: "standard" | "fast";
}

export interface ToolCall {
  id: string;
  name: string;
  input: JsonValue;
  providerMetadata?: Record<string, JsonValue>;
}

export interface ToolExecutionResult {
  toolCallId: string;
  toolName: string;
  output?: JsonValue;
  error?: {
    message: string;
  };
  isError: boolean;
  providerMetadata?: Record<string, JsonValue>;
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
  providerMetadata?: Record<string, JsonValue>;
}

export interface ImagePart {
  type: "image";
  image: string;
  mediaType?: string;
  providerMetadata?: Record<string, JsonValue>;
}

export interface AudioPart {
  type: "audio";
  data: string | Uint8Array | ArrayBuffer;
  mediaType: string;
  filename?: string;
  format?: string;
  transcript?: string;
  providerMetadata?: Record<string, JsonValue>;
}

export interface FilePart {
  type: "file";
  data: string;
  mediaType: string;
  filename?: string;
  providerMetadata?: Record<string, JsonValue>;
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

export type ContentPart = TextPart | ImagePart | AudioPart | FilePart | ToolCallPart | ToolResultPart | ProviderDataPart;

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
  imageGeneration?: boolean;
  videoGeneration?: boolean;
  musicGeneration?: boolean;
  fileSearch?: boolean;
  urlContext?: boolean;
  contextCaching?: boolean;
  explicitPromptCaching?: boolean;
  batch?: boolean;
  interactions?: boolean;
  rawPrediction?: boolean;
  reasoningEfforts?: Array<NonNullable<ReasoningConfig["effort"]>>;
  reasoningModes?: Array<NonNullable<ReasoningConfig["mode"]>>;
  reasoningContexts?: Array<NonNullable<ReasoningConfig["context"]>>;
  computerUse?: boolean;
  reasoning: boolean;
  webSearch: boolean;
  realtime?: {
    sessions: boolean;
    audioInput: boolean;
    audioOutput: boolean;
    imageInput: boolean;
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
  shell?: boolean;
  applyPatch?: boolean;
  toolSearch?: boolean;
  webExtraction?: boolean;
  skills?: boolean;
  programmaticToolCalling?: boolean;
  multiAgent?: boolean;
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

export type ToolApprovalMode = "policy" | "interrupt";

export interface ToolApprovalSigner {
  sign(payload: string): string | Promise<string>;
  verify?(payload: string, signature: string): boolean | Promise<boolean>;
}

export interface ToolGuardrailTrigger {
  triggered: true;
  reason?: string;
  metadata?: Record<string, JsonValue>;
}

export interface ToolRuntimeContext<TContext = any> {
  context?: TContext;
  /** Durable run that owns this execution, when invoked by the agent runtime. */
  runId?: string;
  agentId?: string;
  scope?: AgentStoreScope;
  metadata?: Record<string, JsonValue>;
  /** Acquired execution boundary for this run. Callbacks and secrets are never persisted. */
  executionEnvironment?: AgentExecutionEnvironmentSession<TContext>;
}

export type AgentExecutionEnvironmentBackend =
  | "host"
  | "process"
  | "container"
  | "microvm"
  | "remote"
  | "custom";

export interface AgentExecutionEnvironmentManifest {
  schemaVersion: 1;
  id: string;
  version?: string;
  backend: AgentExecutionEnvironmentBackend;
  assurance: "best-effort" | "enforced";
  isolation: "shared" | "per-run" | "per-tool-call";
  workspace?: {
    id?: string;
    root: string;
    cwd?: string;
    access: "read-only" | "read-write";
    followSymlinks?: boolean;
    readablePaths?: string[];
    writablePaths?: string[];
  };
  permissions?: {
    undeclaredTools?: "allow" | "deny";
    filesystem?: "deny" | "read-only" | "read-write";
    network?: {
      mode: "deny" | "allowlist";
      allowedDomains?: string[];
      allowedPorts?: number[];
      allowPrivateNetworks?: boolean;
    };
    process?: {
      shell: "deny" | "allowlist" | "allow";
      allowedCommands?: string[];
    };
    environment?: {
      inheritedVariables?: string[];
    };
  };
  limits?: {
    maxProcessRuntimeMs?: number;
    maxProcessOutputBytes?: number;
    maxConcurrentProcesses?: number;
    maxMemoryMb?: number;
    maxWorkspaceBytes?: number;
    maxFileWriteBytes?: number;
    maxNetworkRequests?: number;
    maxNetworkBytes?: number;
  };
  metadata?: Record<string, JsonValue>;
}

export interface AgentExecutionEnvironmentBinding {
  environmentId: string;
  environmentVersion?: string;
  fingerprint: string;
  workspaceId?: string;
}

export interface AgentExecutionEnvironmentAcquireRequest<TContext = any> {
  runId: string;
  agentId?: string;
  scope?: AgentStoreScope;
  context?: TContext;
  metadata?: Record<string, JsonValue>;
  abortSignal?: AbortSignal;
}

export interface AgentExecutionAuthorizationRequest<TContext = any> {
  manifest: AgentExecutionEnvironmentManifest;
  binding: AgentExecutionEnvironmentBinding;
  tool: ToolDefinition;
  toolCall: ToolCall;
  input: unknown;
  context: ToolExecutionContext<TContext>;
  phase: "preflight" | "execute";
}

export type AgentExecutionAuthorizationDecision =
  | { decision: "allow"; metadata?: Record<string, JsonValue> }
  | { decision: "deny"; reason: string; metadata?: Record<string, JsonValue> };

export interface AgentExecutionEnvironmentSession<TContext = any> {
  readonly manifest: AgentExecutionEnvironmentManifest;
  readonly binding: AgentExecutionEnvironmentBinding;
  authorize(
    request: AgentExecutionAuthorizationRequest<TContext>
  ): AgentExecutionAuthorizationDecision | Promise<AgentExecutionAuthorizationDecision>;
  execute<TResult>(
    request: AgentExecutionAuthorizationRequest<TContext>,
    operation: () => TResult | Promise<TResult>
  ): TResult | Promise<TResult>;
  release?(result: {
    status: AgentStatus;
    error?: { message: string };
  }): void | Promise<void>;
}

export interface AgentExecutionEnvironment<TContext = any> {
  readonly manifest: AgentExecutionEnvironmentManifest;
  acquire(
    request: AgentExecutionEnvironmentAcquireRequest<TContext>
  ): AgentExecutionEnvironmentSession<TContext> | Promise<AgentExecutionEnvironmentSession<TContext>>;
}

export interface StructuredOutputConfig<TSchema extends ZodTypeAny = ZodTypeAny> {
  schema: TSchema;
  mode: StructuredOutputMode;
  name?: string;
  description?: string;
}

export interface ReasoningConfig {
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  mode?: "standard" | "pro";
  context?: "auto" | "current_turn" | "all_turns";
  budgetTokens?: number;
  includeThoughts?: boolean;
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

export interface StreamToolApprovalRequestEvent {
  type: "tool-approval-request";
  approval: AgentApprovalRequest;
}

export interface StreamProviderDataEvent {
  type: "provider-data";
  provider: string;
  data: JsonValue;
}

export interface StreamImageGenerationEvent {
  type: "image-generation";
  provider: string;
  image: GeneratedMedia;
  partial: boolean;
  id?: string;
  index?: number;
  providerMetadata?: Record<string, JsonValue>;
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
  | StreamToolApprovalRequestEvent
  | StreamProviderDataEvent
  | StreamImageGenerationEvent
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

export interface AgentCompactionEvent {
  type: "agent-compaction";
  compaction: AgentCompactionRecord;
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
  | AgentCompactionEvent
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
  audio?: GeneratedMedia[];
  images?: GeneratedMedia[];
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

export interface MediaInput {
  data?: string | Uint8Array | ArrayBuffer;
  uri?: string;
  mediaType: string;
  filename?: string;
  providerMetadata?: Record<string, unknown>;
}

export type EmbedValue = string | MediaInput;

export interface GeneratedMedia {
  data?: Uint8Array;
  uri?: string;
  mediaType: string;
  text?: string;
  providerMetadata?: Record<string, unknown>;
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

export interface ImageGenerationResult {
  images: GeneratedMedia[];
  text?: string;
  rawResponse?: unknown;
}

export interface VideoGenerationResult {
  videos: GeneratedMedia[];
  operationName?: string;
  rawResponse?: unknown;
}

export interface MusicGenerationResult {
  audio: GeneratedMedia[];
  text?: string;
  rawResponse?: unknown;
}

export interface UploadedFile {
  name: string;
  uri?: string;
  mimeType?: string;
  sizeBytes?: string | number;
  state?: string;
  displayName?: string;
  rawResponse?: unknown;
  providerMetadata?: Record<string, unknown>;
}

export interface FileSearchStore {
  name: string;
  displayName?: string;
  createTime?: string;
  updateTime?: string;
  rawResponse?: unknown;
  providerMetadata?: Record<string, unknown>;
}

export interface CachedContent {
  name: string;
  model?: string;
  displayName?: string;
  createTime?: string;
  updateTime?: string;
  expireTime?: string;
  usageMetadata?: Record<string, unknown>;
  rawResponse?: unknown;
  providerMetadata?: Record<string, unknown>;
}

export interface BatchJob {
  name: string;
  model?: string;
  state?: string;
  done?: boolean;
  createTime?: string;
  updateTime?: string;
  rawResponse?: unknown;
  providerMetadata?: Record<string, unknown>;
}

export type InteractionStatus =
  | "in_progress"
  | "requires_action"
  | "completed"
  | "failed"
  | "cancelled"
  | "incomplete"
  | "budget_exceeded"
  | (string & {});

/**
 * A raw content block returned by an interaction step.
 *
 * Provider field names are intentionally preserved so steps can be sent back
 * unchanged when callers manage stateless interaction history.
 */
export interface InteractionContent {
  type: string;
  text?: string;
  data?: string;
  uri?: string;
  mime_type?: string;
  [key: string]: unknown;
}

/** A chronological step returned by the Interactions API. */
export interface InteractionStep {
  type: string;
  id?: string;
  name?: string;
  arguments?: JsonValue;
  call_id?: string;
  content?: InteractionContent[];
  result?: InteractionContent[] | JsonValue;
  signature?: string;
  summary?: InteractionContent[];
  status?: string;
  [key: string]: unknown;
}

export interface Interaction {
  id: string;
  name?: string;
  model?: string;
  agent?: string;
  status?: InteractionStatus;
  object?: string;
  createTime?: string;
  updateTime?: string;
  previousInteractionId?: string;
  environmentId?: string;
  steps?: InteractionStep[];
  /**
   * Backward-compatible output blocks. Current responses are normalized from
   * the latest model output step when the provider no longer returns outputs.
   */
  outputs?: unknown[];
  outputText?: string;
  outputImage?: InteractionContent;
  outputAudio?: InteractionContent;
  outputVideo?: InteractionContent;
  usage?: TokenUsage;
  error?: unknown;
  rawResponse?: unknown;
  providerMetadata?: Record<string, unknown>;
}

export interface PredictionOperation {
  name: string;
  done?: boolean;
  response?: unknown;
  error?: unknown;
  metadata?: unknown;
  rawResponse?: unknown;
}

export interface PredictionResult {
  predictions?: unknown[];
  operationName?: string;
  operation?: PredictionOperation;
  rawResponse?: unknown;
  providerMetadata?: Record<string, unknown>;
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
  streamSpeech?(input: SpeechModelInput<TProviderOptions>): Promise<AsyncIterable<SpeechResult>>;
}

export interface ImageGenerationModel<TProviderOptions extends ProviderOptions = ProviderOptions> {
  readonly provider: string;
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;
  generateImage(input: ImageGenerationModelInput<TProviderOptions>): Promise<ImageGenerationResult>;
}

export interface VideoGenerationModel<TProviderOptions extends ProviderOptions = ProviderOptions> {
  readonly provider: string;
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;
  generateVideo(input: VideoGenerationModelInput<TProviderOptions>): Promise<VideoGenerationResult>;
}

export interface MusicGenerationModel<TProviderOptions extends ProviderOptions = ProviderOptions> {
  readonly provider: string;
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;
  generateMusic(input: MusicGenerationModelInput<TProviderOptions>): Promise<MusicGenerationResult>;
}

export interface FileUploadInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  data: string | Uint8Array | ArrayBuffer | Blob;
  mediaType: string;
  displayName?: string;
  name?: string;
  filename?: string;
  providerOptions?: TProviderOptions;
}

export interface FileListInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  pageSize?: number;
  pageToken?: string;
  providerOptions?: TProviderOptions;
}

export interface FileGetInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  name: string;
  providerOptions?: TProviderOptions;
}

export interface FileDeleteInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  name: string;
  providerOptions?: TProviderOptions;
}

export interface FilesClient<TProviderOptions extends ProviderOptions = ProviderOptions> {
  upload(input: FileUploadInput<TProviderOptions>): Promise<UploadedFile>;
  get(input: FileGetInput<TProviderOptions>): Promise<UploadedFile>;
  list(input?: FileListInput<TProviderOptions>): Promise<{ files: UploadedFile[]; nextPageToken?: string; rawResponse?: unknown }>;
  delete(input: FileDeleteInput<TProviderOptions>): Promise<{ name: string; rawResponse?: unknown }>;
}

export interface FileSearchStoreCreateInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  displayName?: string;
  providerOptions?: TProviderOptions;
}

export interface FileSearchStoreListInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  pageSize?: number;
  pageToken?: string;
  providerOptions?: TProviderOptions;
}

export interface FileSearchStoreGetInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  name: string;
  providerOptions?: TProviderOptions;
}

export interface FileSearchStoreDeleteInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  name: string;
  providerOptions?: TProviderOptions;
}

export interface FileSearchStoreUploadInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  storeName: string;
  data: string | Uint8Array | ArrayBuffer | Blob;
  mediaType: string;
  displayName?: string;
  filename?: string;
  pollIntervalMs?: number;
  providerOptions?: TProviderOptions;
}

export interface FileSearchStoreImportInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  storeName: string;
  fileName: string;
  pollIntervalMs?: number;
  providerOptions?: TProviderOptions;
}

export interface FileSearchStoresClient<TProviderOptions extends ProviderOptions = ProviderOptions> {
  create(input?: FileSearchStoreCreateInput<TProviderOptions>): Promise<FileSearchStore>;
  upload(input: FileSearchStoreUploadInput<TProviderOptions>): Promise<PredictionOperation>;
  importFile(input: FileSearchStoreImportInput<TProviderOptions>): Promise<PredictionOperation>;
  get(input: FileSearchStoreGetInput<TProviderOptions>): Promise<FileSearchStore>;
  list(input?: FileSearchStoreListInput<TProviderOptions>): Promise<{ stores: FileSearchStore[]; nextPageToken?: string; rawResponse?: unknown }>;
  delete(input: FileSearchStoreDeleteInput<TProviderOptions>): Promise<{ name: string; rawResponse?: unknown }>;
}

export interface ContextCacheCreateInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  modelId: string;
  contents: ModelMessage[];
  system?: string;
  displayName?: string;
  ttl?: string;
  expireTime?: string;
  tools?: ToolCollection;
  providerOptions?: TProviderOptions;
}

export interface ContextCacheGetInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  name: string;
  providerOptions?: TProviderOptions;
}

export interface ContextCacheListInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  pageSize?: number;
  pageToken?: string;
  providerOptions?: TProviderOptions;
}

export interface ContextCacheDeleteInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  name: string;
  providerOptions?: TProviderOptions;
}

export interface ContextCachesClient<TProviderOptions extends ProviderOptions = ProviderOptions> {
  create(input: ContextCacheCreateInput<TProviderOptions>): Promise<CachedContent>;
  get(input: ContextCacheGetInput<TProviderOptions>): Promise<CachedContent>;
  list(input?: ContextCacheListInput<TProviderOptions>): Promise<{ caches: CachedContent[]; nextPageToken?: string; rawResponse?: unknown }>;
  delete(input: ContextCacheDeleteInput<TProviderOptions>): Promise<{ name: string; rawResponse?: unknown }>;
}

export interface BatchCreateInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  modelId: string;
  displayName?: string;
  requests?: Array<{ request: unknown; metadata?: Record<string, unknown> }>;
  fileName?: string;
  providerOptions?: TProviderOptions;
}

export interface BatchGetInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  name: string;
  providerOptions?: TProviderOptions;
}

export interface BatchListInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  pageSize?: number;
  pageToken?: string;
  providerOptions?: TProviderOptions;
}

export interface BatchDeleteInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  name: string;
  providerOptions?: TProviderOptions;
}

export interface BatchCancelInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  name: string;
  providerOptions?: TProviderOptions;
}

export interface BatchesClient<TProviderOptions extends ProviderOptions = ProviderOptions> {
  create(input: BatchCreateInput<TProviderOptions>): Promise<BatchJob>;
  get(input: BatchGetInput<TProviderOptions>): Promise<BatchJob>;
  list(input?: BatchListInput<TProviderOptions>): Promise<{ batches: BatchJob[]; nextPageToken?: string; rawResponse?: unknown }>;
  cancel(input: BatchCancelInput<TProviderOptions>): Promise<BatchJob>;
  delete(input: BatchDeleteInput<TProviderOptions>): Promise<{ name: string; rawResponse?: unknown }>;
}

export interface InteractionCreateInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  modelId?: string;
  agent?: string;
  input: unknown;
  previousInteractionId?: string;
  tools?: ToolCollection;
  systemInstruction?: string;
  responseFormat?: JsonValue | JsonValue[];
  generationConfig?: JsonValue;
  agentConfig?: JsonValue;
  environment?: string | JsonValue;
  labels?: Record<string, string>;
  background?: boolean;
  store?: boolean;
  providerOptions?: TProviderOptions;
}

export interface InteractionGetInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  id: string;
  providerOptions?: TProviderOptions;
}

export interface InteractionCancelInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  id: string;
  providerOptions?: TProviderOptions;
}

export interface InteractionDeleteInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  id: string;
  providerOptions?: TProviderOptions;
}

export interface InteractionResumeInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  id: string;
  lastEventId?: string;
  providerOptions?: TProviderOptions;
}

export interface InteractionsClient<TProviderOptions extends ProviderOptions = ProviderOptions> {
  create(input: InteractionCreateInput<TProviderOptions>): Promise<Interaction>;
  get(input: InteractionGetInput<TProviderOptions>): Promise<Interaction>;
  cancel(input: InteractionCancelInput<TProviderOptions>): Promise<Interaction>;
  delete(input: InteractionDeleteInput<TProviderOptions>): Promise<{ id: string; rawResponse?: unknown }>;
  resume(input: InteractionResumeInput<TProviderOptions>): Promise<AsyncIterable<StreamEvent>>;
  stream(input: InteractionCreateInput<TProviderOptions>): Promise<AsyncIterable<StreamEvent>>;
}

export interface PredictionModel<TProviderOptions extends ProviderOptions = ProviderOptions> {
  readonly provider: string;
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;
  predictRaw(input: PredictionModelInput<TProviderOptions>): Promise<PredictionResult>;
  rawPredict?(input: PredictionModelInput<TProviderOptions>): Promise<PredictionResult>;
  invoke?(input: PredictionModelInput<TProviderOptions>): Promise<PredictionResult>;
  predictLongRunning(input: PredictionModelInput<TProviderOptions>): Promise<PredictionOperation>;
  fetchPredictionOperation(input: PredictionOperationInput<TProviderOptions>): Promise<PredictionOperation>;
}

export interface AudioFrame {
  data: string | Uint8Array | ArrayBuffer;
  mediaType: string;
  sampleRateHz?: number;
  channels?: number;
  isFinal?: boolean;
}

export interface MediaFrame {
  data: string | Uint8Array | ArrayBuffer;
  mediaType: string;
}

export interface RealtimeConnectOptions {
  /** Maximum time allowed to establish the provider transport. */
  timeoutMs?: number;
  /** Cancels connection establishment and is passed to the transport for session-lifetime cancellation. */
  signal?: AbortSignal;
  subprotocols?: string[];
  /** Maximum accepted inbound WebSocket frame size. */
  maxIncomingFrameBytes?: number;
}

export interface RealtimeSessionConfig {
  mode?: "conversation" | "translation" | "transcription";
  instructions?: string;
  voice?: string;
  tools?: ToolCollection;
  toolChoice?: ToolChoice;
  reasoning?: ReasoningConfig;
  inputTranscription?: {
    model?: string;
    language?: string;
    prompt?: string;
    includeLogprobs?: boolean;
    delay?: "minimal" | "low" | "medium" | "high" | "xhigh";
  };
  inputAudioTranscription?: boolean | Record<string, unknown>;
  /** Enable this when an audio-output model must also produce `outputText`. */
  outputAudioTranscription?: boolean | Record<string, unknown>;
  translation?: {
    targetLanguage: string;
    sourceLanguage?: string;
    instructions?: string;
  };
  inputAudioMediaType?: string;
  outputAudioMediaType?: string;
  inputSampleRateHz?: number;
  outputSampleRateHz?: number;
  channels?: number;
  turnDetection?: Record<string, unknown> | null;
  noiseReduction?: Record<string, unknown> | null;
  mediaResolution?: string;
  affectiveDialog?: boolean;
  proactiveAudio?: boolean;
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
  /** Complete transcript when `isFinal` is true; otherwise an incremental chunk. */
  text: string;
  role: "user" | "assistant";
  /** Explicit provider signal that no more transcript chunks remain for this item. */
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

export interface RealtimeProviderDataEvent {
  type: "realtime-provider-data";
  provider: string;
  data: JsonValue;
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
  | RealtimeProviderDataEvent
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
  sendMedia(frame: MediaFrame): Promise<void>;
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
  imageGenerationModel?: (modelId: string) => ImageGenerationModel;
  videoGenerationModel?: (modelId: string) => VideoGenerationModel;
  musicGenerationModel?: (modelId: string) => MusicGenerationModel;
  realtimeModel?: (modelId: string) => RealtimeModel;
  groundedLanguageModel?: (modelId: string) => GroundedLanguageModel;
  files?: FilesClient;
  fileSearchStores?: FileSearchStoresClient;
  caches?: ContextCachesClient;
  batches?: BatchesClient;
  interactions?: InteractionsClient;
  predictionModel?: (modelId: string) => PredictionModel;
}

export type CallableProviderAdapter = ProviderAdapter & ((modelId: string) => LanguageModel);

export interface ToolDefinition<
  TSchema extends ZodTypeAny = any,
  TResult = JsonValue,
  TContext = any
> {
  name: string;
  description?: string;
  schema: TSchema;
  metadata?: Record<string, JsonValue>;
  requiresApproval?: boolean;
  /**
   * "policy" preserves the immediate allow/deny policy behavior. "interrupt"
   * creates a resumable local approval request before any tool side effect.
   */
  approvalMode?: ToolApprovalMode;
  /** Bump when approval-relevant tool behavior changes so stale approvals cannot be replayed. */
  approvalVersion?: string;
  isEnabled?: (
    input: z.infer<TSchema>,
    context: ToolExecutionContext<TContext>
  ) => boolean | Promise<boolean>;
  inputGuardrails?: ToolInputGuardrail<TSchema, TContext>[];
  outputGuardrails?: ToolOutputGuardrail<TSchema, TResult, TContext>[];
  onError?: ToolErrorHandler<TSchema, TResult, TContext>;
  execute: (
    input: z.infer<TSchema>,
    context?: ToolExecutionContext<TContext>
  ) => Promise<TResult> | TResult;
}

export interface ToolExecutionContext<TContext = any> extends ToolRuntimeContext<TContext> {
  abortSignal?: AbortSignal;
  toolCall: ToolCall;
  step: number;
  model: LanguageModel | RealtimeModel;
  /** Forward this key to side-effecting APIs to make retries externally idempotent. */
  idempotencyKey?: string;
  request?: ModelGenerateInput;
  realtimeConfig?: RealtimeSessionConfig;
}

export interface ToolInputGuardrailRequest<
  TSchema extends ZodTypeAny = any,
  TContext = any
> {
  tool: ToolDefinition;
  input: z.infer<TSchema>;
  context: ToolExecutionContext<TContext>;
}

export interface ToolOutputGuardrailRequest<
  TSchema extends ZodTypeAny = any,
  TResult = JsonValue,
  TContext = any
> extends ToolInputGuardrailRequest<TSchema, TContext> {
  output: TResult;
}

export type ToolInputGuardrail<
  TSchema extends ZodTypeAny = any,
  TContext = any
> = (
  request: ToolInputGuardrailRequest<TSchema, TContext>
) => ToolGuardrailTrigger | void | Promise<ToolGuardrailTrigger | void>;

export type ToolOutputGuardrail<
  TSchema extends ZodTypeAny = any,
  TResult = JsonValue,
  TContext = any
> = (
  request: ToolOutputGuardrailRequest<TSchema, TResult, TContext>
) => ToolGuardrailTrigger | void | Promise<ToolGuardrailTrigger | void>;

export type ToolErrorHandler<
  TSchema extends ZodTypeAny = any,
  TResult = JsonValue,
  TContext = any
> = (
  error: Error,
  request: ToolInputGuardrailRequest<TSchema, TContext>
) => TResult | void | Promise<TResult | void>;

export type HostedToolClass =
  | "web-search"
  | "file-search"
  | "remote-mcp"
  | "computer-use"
  | "code-execution"
  | "shell"
  | "apply-patch"
  | "tool-search"
  | "web-extraction"
  | "skill"
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

export type AnyToolDefinition = ToolDefinition<any, any, any> | HostedToolDefinition;

export type ToolSet = Record<string, AnyToolDefinition>;

export interface ToolRegistryLike {
  get(name: string): AnyToolDefinition | undefined;
  has(name: string): boolean;
  entries(): Iterable<[string, AnyToolDefinition]>;
  toToolSet(): ToolSet;
}

export type ToolCollection = ToolSet | ToolRegistryLike;

export interface ToolApprovalRequest<TContext = any> {
  toolCall: ToolCall;
  tool: ToolDefinition;
  input: JsonValue;
  step: number;
  model: LanguageModel | RealtimeModel;
  request?: ModelGenerateInput;
  executionContext?: ToolExecutionContext<TContext>;
  realtimeConfig?: RealtimeSessionConfig;
}

export interface ToolApprovalDecision {
  approved: boolean;
  /** Requests resumable human approval instead of treating approved:false as a final denial. */
  approvalRequired?: boolean;
  reason?: string;
  metadata?: Record<string, JsonValue>;
}

export interface ToolApprovalEvent {
  request: ToolApprovalRequest;
  decision: ToolApprovalDecision;
}

export type ToolApprovalPolicy<TContext = any> = (
  request: ToolApprovalRequest<TContext>
) => ToolApprovalDecision | boolean | Promise<ToolApprovalDecision | boolean>;

export type ToolApprovalObserver = (
  event: ToolApprovalEvent
) => void | Promise<void>;

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
    }) => void | Promise<void>;
    /** Durable runtimes use this hook to checkpoint tool results before the next model request. */
    onToolExecutionComplete?: (context: {
      request: ModelGenerateInput;
      step: number;
      toolResults: ToolExecutionResult[];
    }) => void | Promise<void>;
    /** Existing completed steps preceding this invocation. */
    stepOffset?: number;
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
  /** Local resumable approval requests produced before any tool in the batch executes. */
  approvalRequests?: AgentApprovalRequest[];
}

export type AgentStatus =
  | "queued"
  | "running"
  | "completed"
  /**
   * @deprecated Use "waiting_approval". Kept for legacy persisted run states.
   */
  | "suspended"
  | "waiting_approval"
  | "cancel_requested"
  | "failed"
  | "cancelled"
  | "timed_out";

export type AgentStepStatus = "running" | "completed" | "suspended" | "waiting_approval" | "failed";

export interface AgentRunPolicy {
  timeoutMs?: number;
  onTimeout?: "fail" | "cancel-requested";
  /** Explicit migration escape hatch for pre-fingerprint durable states. */
  allowLegacyHarnessResume?: boolean;
  /** Explicit migration escape hatch for states created before environment binding. */
  allowLegacyExecutionEnvironmentResume?: boolean;
  /** Disable only for stores that intentionally provide CAS without worker leases. */
  leaseMode?: "required" | "disabled";
  /** Duration of the exclusive worker lease. Defaults to 30 seconds. */
  leaseTtlMs?: number;
  /** Lease renewal interval. Defaults to one third of leaseTtlMs. */
  heartbeatMs?: number;
  /** How often an active worker checks durable cancellation. Defaults to 1 second. */
  cancellationPollMs?: number;
  /** Maximum retained events for agent stream replay. Defaults to 4096. */
  maxStreamEvents?: number;
  /** Maximum serialized durable state size. Defaults to 4 MiB. */
  maxStateBytes?: number;
  /** Optional preflight limits enforced before model and tool operations. */
  budget?: {
    maxSteps?: number;
    maxToolCalls?: number;
    maxToolErrors?: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    maxTotalTokens?: number;
    includeChildRuns?: boolean;
  };
}

export type AgentCompactionReason =
  | "message-count"
  | "estimated-input-tokens";

export interface AgentCompactionRequest<TContext = any> {
  runId: string;
  agentId?: string;
  scope?: AgentStoreScope;
  beforeStep: number;
  context?: TContext;
  /** Historical prefix being summarized. System messages are never included. */
  messages: ModelMessage[];
  /** Literal tail preserved after the summary. */
  retainedMessages: ModelMessage[];
  reasons: AgentCompactionReason[];
  estimatedTokensBefore: number;
  sourceDigest: string;
  idempotencyKey: string;
  metadata?: Record<string, JsonValue>;
  abortSignal?: AbortSignal;
}

export interface AgentCompactionResult {
  summary: string;
  usage?: TokenUsage;
  metadata?: Record<string, JsonValue>;
}

export type AgentCompactor<TContext = any> = (
  request: AgentCompactionRequest<TContext>
) => AgentCompactionResult | Promise<AgentCompactionResult>;

export interface AgentCompactionOptions<TContext = any> {
  /** Compaction runs when either configured threshold is exceeded. */
  maxMessages?: number;
  maxEstimatedInputTokens?: number;
  /** Literal non-system tail retained after compaction. Defaults to 8 messages. */
  keepRecentMessages?: number;
  estimateTokens?: (messages: readonly ModelMessage[]) => number;
  compactor: AgentCompactor<TContext>;
}

export interface AgentCompactionRecord {
  id: string;
  beforeStep: number;
  createdAt: number;
  reasons: AgentCompactionReason[];
  sourceDigest: string;
  resultDigest: string;
  summaryDigest: string;
  summary: string;
  messageCountBefore: number;
  messageCountAfter: number;
  compactedMessageCount: number;
  retainedMessageCount: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  usage?: TokenUsage;
  metadata?: Record<string, JsonValue>;
}

export interface AgentStepRequest {
  /** Index in the full conversation where this incremental snapshot begins. */
  messageOffset?: number;
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

export interface AgentChildRun {
  runId: string;
  agentId?: string;
  parentRunId?: string;
  toolName?: string;
  toolCallId?: string;
  status: AgentStatus;
  outputText: string;
  steps: number;
  toolCalls: number;
  toolErrors: number;
  usage?: TokenUsage;
  startedAt?: number;
  updatedAt?: number;
  error?: {
    message: string;
  };
  metadata?: Record<string, JsonValue>;
  /** Durable child state retained only while the parent must resume a child approval. */
  resumeState?: AgentRunState;
}

export interface AgentHarnessBinding {
  schemaVersion: 1;
  id: string;
  version: string;
  fingerprint: string;
  algorithm: "sha256";
}

export interface AgentRunState {
  schemaVersion: 1;
  /**
   * Monotonic durable-store revision. Legacy states without a revision are
   * normalized to revision 0 before their next write.
   */
  revision?: number;
  /** Tenant/user isolation boundary propagated by the runtime. */
  scope?: AgentStoreScope;
  runId: string;
  idempotencyKey?: string;
  agentId?: string;
  parentRunId?: string;
  provider: string;
  modelId: string;
  harness?: AgentHarnessBinding;
  executionEnvironment?: AgentExecutionEnvironmentBinding;
  status: AgentStatus;
  messages: ModelMessage[];
  steps: AgentStep[];
  toolResults: ToolExecutionResult[];
  currentStep: number;
  maxSteps: number;
  outputText: string;
  finalOutput?: JsonValue;
  outputMode?: Exclude<StructuredOutputMode, "auto">;
  finishReason?: FinishReason;
  providerFinishReason?: string;
  usage?: TokenUsage;
  pendingApprovals: AgentApprovalRequest[];
  approvalHistory?: AgentApprovalResolution[];
  childRuns?: AgentChildRun[];
  compactions?: AgentCompactionRecord[];
  metadata?: Record<string, JsonValue>;
  handoff?: AgentHandoff;
  startedAt?: number;
  updatedAt?: number;
  cancelledAt?: number;
  cancellationReason?: string;
  error?: {
    message: string;
  };
}

/**
 * Logical isolation boundary for durable agent data. Applications should use
 * one scope per tenant and, when memory must be private, per end user.
 */
export interface AgentStoreScope {
  tenantId: string;
  userId?: string;
  namespace?: string;
}

export interface AgentRunStoreScopeOptions {
  /** Fixed scope applied to every key handled by this store instance. */
  scope?: AgentStoreScope;
}

export interface AgentRunLease {
  runId: string;
  ownerId: string;
  expiresAt: number;
}

export interface AgentRunLeaseOptions {
  ownerId: string;
  ttlMs: number;
  /** Injectable clock used by deterministic workers and tests. */
  now?: number;
}

export type AgentToolCallJournalStatus = "pending" | "running" | "completed" | "failed";

export interface AgentToolCallJournalEntry {
  runId: string;
  scope?: AgentStoreScope;
  toolCallId: string;
  toolName: string;
  status: AgentToolCallJournalStatus;
  /** Stable key that must also be forwarded to side-effecting integrations. */
  idempotencyKey: string;
  revision: number;
  input?: JsonValue;
  output?: JsonValue;
  error?: { message: string };
  startedAt?: number;
  completedAt?: number;
  updatedAt: number;
}

export interface AgentToolCallJournalSaveOptions {
  expectedRevision?: number;
}

export interface AgentToolExecutionClaimResult {
  claimed: boolean;
  entry: AgentToolCallJournalEntry;
}

export interface AgentRunListOptions {
  agentId?: string;
  parentRunId?: string;
  statuses?: AgentStatus[];
  updatedAfter?: number;
  updatedBefore?: number;
  limit?: number;
  /** Opaque cursor returned by the previous page. */
  cursor?: string;
}

export interface AgentRunPage {
  items: AgentRunState[];
  nextCursor?: string;
}

export interface AgentRunRetentionOptions {
  before: number;
  statuses?: AgentStatus[];
  limit?: number;
}

export interface AgentRunSaveOptions {
  expectedRevision?: number;
}

export interface AgentRunClaimResult {
  claimed: boolean;
  state: AgentRunState;
}

export interface AgentRunStore {
  load(runId: string, scope?: AgentStoreScope): Promise<AgentRunState | undefined> | AgentRunState | undefined;
  findByIdempotencyKey?(idempotencyKey: string, scope?: AgentStoreScope): Promise<AgentRunState | undefined> | AgentRunState | undefined;
  findByParentRunId?(parentRunId: string, scope?: AgentStoreScope): Promise<AgentRunState[]> | AgentRunState[];
  /**
   * Atomically reserves an idempotency key for a fresh run. Returns the
   * caller's state when the reservation succeeds, or the already-reserved
   * state when another caller owns the key.
   */
  claimIdempotencyKey?(
    state: AgentRunState & { idempotencyKey: string }
  ): Promise<AgentRunClaimResult> | AgentRunClaimResult;
  save(state: AgentRunState, options?: AgentRunSaveOptions): Promise<void> | void;
  delete?(runId: string, scope?: AgentStoreScope): Promise<void> | void;
  list?(options?: AgentRunListOptions, scope?: AgentStoreScope): Promise<AgentRunPage> | AgentRunPage;
  deleteExpired?(options: AgentRunRetentionOptions, scope?: AgentStoreScope): Promise<number> | number;
  acquireLease?(runId: string, options: AgentRunLeaseOptions, scope?: AgentStoreScope): Promise<AgentRunLease | undefined> | AgentRunLease | undefined;
  renewLease?(runId: string, options: AgentRunLeaseOptions, scope?: AgentStoreScope): Promise<AgentRunLease | undefined> | AgentRunLease | undefined;
  releaseLease?(runId: string, ownerId: string, scope?: AgentStoreScope): Promise<boolean> | boolean;
  loadToolCall?(runId: string, toolCallId: string, scope?: AgentStoreScope): Promise<AgentToolCallJournalEntry | undefined> | AgentToolCallJournalEntry | undefined;
  loadToolExecution?(runId: string, toolCallId: string, scope?: AgentStoreScope): Promise<AgentToolCallJournalEntry | undefined> | AgentToolCallJournalEntry | undefined;
  listToolCalls?(runId: string, scope?: AgentStoreScope): Promise<AgentToolCallJournalEntry[]> | AgentToolCallJournalEntry[];
  saveToolCall?(
    entry: AgentToolCallJournalEntry,
    options?: AgentToolCallJournalSaveOptions
  ): Promise<AgentToolCallJournalEntry> | AgentToolCallJournalEntry;
  claimToolExecution?(
    entry: AgentToolCallJournalEntry
  ): Promise<AgentToolExecutionClaimResult> | AgentToolExecutionClaimResult;
  completeToolExecution?(
    entry: AgentToolCallJournalEntry,
    options: AgentToolCallJournalSaveOptions & { expectedRevision: number }
  ): Promise<AgentToolCallJournalEntry> | AgentToolCallJournalEntry;
}

export interface AgentRunCancellationOptions {
  reason?: string;
  cascade?: boolean;
  mode?: "request" | "final";
  scope?: AgentStoreScope;
}

export interface AgentRunTreeCancellationResult {
  parent?: AgentRunState;
  children: AgentRunState[];
}

export interface AgentMemoryContext {
  runId: string;
  agentId?: string;
  scope?: AgentStoreScope;
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
  all?(params?: readonly unknown[] | Record<string, unknown>): TResult[];
}

export interface SqliteDatabaseLike {
  exec(sql: string): unknown;
  prepare?<TResult extends Record<string, unknown> = Record<string, unknown>>(sql: string): SqliteStatementLike<TResult>;
  query?<TResult extends Record<string, unknown> = Record<string, unknown>>(sql: string): SqliteStatementLike<TResult>;
}

export interface SqliteAgentRunStoreOptions {
  db: SqliteDatabaseLike;
  tableName?: string;
  scope?: AgentStoreScope;
}

export interface SqliteAgentMemoryStoreOptions {
  db: SqliteDatabaseLike;
  tableName?: string;
  key?: (context: AgentMemoryContext) => string;
  selectMessages?: (state: AgentRunState) => ModelMessage[];
  scope?: AgentStoreScope;
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
  scope?: AgentStoreScope;
}

export interface PostgresAgentMemoryStoreOptions {
  client: PostgresClientLike;
  tableName?: string;
  key?: (context: AgentMemoryContext) => string;
  selectMessages?: (state: AgentRunState) => ModelMessage[];
  scope?: AgentStoreScope;
}

export interface AgentHandoff {
  id: string;
  fromRunId: string;
  scope?: AgentStoreScope;
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

export interface AgentInputGuardrailRequest<TContext = any> {
  runId: string;
  agentId?: string;
  context?: TContext;
  state: AgentRunState;
  messages: ModelMessage[];
  metadata?: Record<string, JsonValue>;
}

export interface AgentOutputGuardrailRequest<TContext = any, TOutput = any> {
  runId: string;
  agentId?: string;
  context?: TContext;
  state: AgentRunState;
  output: AgentRunOutput<TOutput> | LiveAgentRunOutput;
  metadata?: Record<string, JsonValue>;
}

export type AgentInputGuardrail<TContext = any> = (
  request: AgentInputGuardrailRequest<TContext>
) => AgentGuardrailTrigger | void | Promise<AgentGuardrailTrigger | void>;

export type AgentOutputGuardrail<TContext = any, TOutput = any> = (
  request: AgentOutputGuardrailRequest<TContext, TOutput>
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

export interface AgentTelemetrySubAgentStartEvent {
  type: "subagent-start";
  runId: string;
  agentId?: string;
  childAgentId?: string;
  toolName: string;
}

export interface AgentTelemetrySubAgentFinishEvent {
  type: "subagent-finish";
  runId: string;
  agentId?: string;
  childRun: AgentChildRun;
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
  | AgentTelemetrySubAgentStartEvent
  | AgentTelemetrySubAgentFinishEvent
  | AgentTelemetryRunFinishEvent;

export type AgentTelemetryObserver = (
  event: AgentTelemetryEvent
) => void | Promise<void>;

export type AgentHookFailureMode = "ignore" | "fail";

export interface AgentOperationalError {
  source: "telemetry" | "memory";
  operation: string;
  runId?: string;
  error: Error;
}

export interface AgentHookFailurePolicy {
  /** Telemetry is best-effort by default and cannot fail a run. */
  telemetry?: AgentHookFailureMode;
  /** Memory hooks are best-effort by default and cannot fail durable execution. */
  memory?: AgentHookFailureMode;
  onError?: (event: AgentOperationalError) => void | Promise<void>;
}

export interface AgentDefinition<
  TModel extends LanguageModel = LanguageModel,
  TContext = any,
  TOutput = any
> {
  id?: string;
  model: TModel;
  instructions?: string;
  contextSchema?: z.ZodType<TContext>;
  tools?: ToolCollection;
  maxSteps?: number;
  temperature?: number;
  maxTokens?: number;
  reasoning?: ReasoningConfig;
  outputSchema?: z.ZodType<TOutput>;
  outputMode?: StructuredOutputMode;
  outputName?: string;
  outputDescription?: string;
  toolExecution?: ToolExecutionOptions;
  toolApprovalPolicy?: ToolApprovalPolicy<TContext>;
  toolApprovalSigner?: ToolApprovalSigner;
  inputGuardrails?: AgentInputGuardrail<TContext>[];
  outputGuardrails?: AgentOutputGuardrail<TContext, TOutput>[];
  providerOptions?: ProviderOptionsOf<TModel>;
  subagents?: AgentSubAgentDefinition[];
  /** Immutable identity of the capsule/spec that owns durable resume semantics. */
  harness?: AgentHarnessBinding;
  executionEnvironment?: AgentExecutionEnvironment<TContext>;
  compaction?: AgentCompactionOptions<TContext>;
  policy?: AgentRunPolicy;
  metadata?: Record<string, JsonValue>;
  store?: AgentRunStore;
  memory?: AgentMemoryStore;
  onTelemetryEvent?: AgentTelemetryObserver;
  hookFailurePolicy?: AgentHookFailurePolicy;
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
  /** Absent on legacy persisted states and treated as "provider". */
  kind?: "provider" | "local-tool" | "subagent";
  provider: string;
  id: string;
  name: string;
  arguments: string;
  serverLabel?: string;
  toolCallId?: string;
  step?: number;
  inputDigest?: string;
  toolVersion?: string;
  signature?: string;
  childRunId?: string;
  childAgentId?: string;
  childApprovalRequestId?: string;
  rawData: JsonValue;
}

export interface AgentApprovalResponse {
  provider: string;
  approvalRequestId: string;
  approve: boolean;
  id?: string;
  reason?: string;
}

export interface AgentApprovalResolution {
  requestId: string;
  kind: "provider" | "local-tool" | "subagent";
  provider: string;
  approve: boolean;
  reason?: string;
  toolCallId?: string;
  step?: number;
  inputDigest?: string;
  toolVersion?: string;
  signature?: string;
  childRunId?: string;
  childAgentId?: string;
  childApprovalRequestId?: string;
  resolvedAt: number;
}

export type AgentRunInput<
  TModel extends LanguageModel = LanguageModel,
  TContext = any
> = RetryOptions &
  GenerateInputSource & {
    runId?: string;
    /** Required isolation boundary for shared durable stores and memory. */
    scope?: AgentStoreScope;
    idempotencyKey?: string;
    /** Ephemeral application context. Callers must provide it again when resuming a run. */
    context?: TContext;
    state?: AgentRunState;
    approvals?: AgentApprovalResponse[];
    handoff?: AgentHandoff;
    parentRunId?: string;
    system?: string;
    tools?: ToolCollection;
    toolChoice?: ToolChoice;
    toolExecution?: ToolExecutionOptions;
    toolApprovalPolicy?: ToolApprovalPolicy<TContext>;
    executionEnvironment?: AgentExecutionEnvironment<TContext>;
    /** Pass false to disable the agent default for this invocation. */
    compaction?: AgentCompactionOptions<TContext> | false;
    maxSteps?: number;
    temperature?: number;
    maxTokens?: number;
    reasoning?: ReasoningConfig;
    providerOptions?: ProviderOptionsOf<TModel>;
    policy?: AgentRunPolicy;
    metadata?: Record<string, JsonValue>;
  };

export interface AgentRunOutput<TOutput = unknown> {
  status: AgentStatus;
  outputText: string;
  finalOutput?: TOutput;
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

export interface AgentSubAgentDefinition<TModel extends LanguageModel = LanguageModel> {
  agent: AgentDefinition<TModel>;
  name?: string;
  description?: string;
  maxSteps?: number;
  system?: string;
  metadata?: Record<string, JsonValue>;
  requiresApproval?: boolean;
}

export interface SubAgentToolInput {
  prompt: string;
  system?: string;
}

export type SubAgentToolOutput = Record<string, JsonValue>;

export interface CreateSubAgentToolOptions<TModel extends LanguageModel = LanguageModel> extends AgentSubAgentDefinition<TModel> {
  parentRunId?: string;
  parentAgentId?: string;
  scope?: AgentStoreScope;
  toolName?: string;
  onStart?: (request: { toolName: string; childAgentId?: string; parentRunId?: string }) => void | Promise<void>;
  onFinish?: (childRun: AgentChildRun) => void | Promise<void>;
}

export interface AgentGroupMember<TModel extends LanguageModel = LanguageModel> {
  name?: string;
  agent: AgentDefinition<TModel>;
  input?: AgentRunInput<TModel>;
}

export type AgentGroupRunInput<TModel extends LanguageModel = LanguageModel> = AgentRunInput<TModel> & {
  stopOnError?: boolean;
};

export interface AgentGroupMemberResult {
  name?: string;
  agentId?: string;
  status: "fulfilled" | "rejected";
  output?: AgentRunOutput;
  error?: {
    message: string;
  };
}

export interface AgentGroupRunOutput {
  status: "completed" | "failed";
  parentRunId?: string;
  outputs: AgentGroupMemberResult[];
}

export interface PrepareSubagentsForAgentOptions {
  store?: AgentRunStore;
  memory?: AgentMemoryStore;
  onTelemetryEvent?: AgentTelemetryObserver;
  toolApprovalPolicy?: ToolApprovalPolicy;
  toolExecution?: ToolExecutionOptions;
  executionEnvironment?: AgentExecutionEnvironment;
  compaction?: AgentCompactionOptions;
  metadata?: Record<string, JsonValue>;
}

export type LiveAgentRunInput = GenerateInputSource &
  RetryOptions & {
    runId?: string;
    /** Tenant/user isolation boundary propagated to durable state, memory, and tool journals. */
    scope?: AgentStoreScope;
    /**
     * Atomically reserves this invocation when a durable store is configured.
     * A terminal reservation is replayed without opening another realtime session.
     */
    idempotencyKey?: string;
    system?: string;
    tools?: ToolCollection;
    toolChoice?: ToolChoice;
    toolExecution?: ToolExecutionOptions;
    /**
     * Live sessions support immediate allow/deny decisions. Returning
     * `approvalRequired: true` fails closed because live runs do not expose a
     * resumable approval handle.
     */
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

export interface AgentStreamResult<TOutput = unknown> {
  eventStream: AsyncIterable<AgentStreamEvent>;
  textStream: AsyncIterable<string>;
  collect: () => Promise<AgentRunOutput<TOutput>>;
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

export type StreamSpeechOptions<TModel extends SpeechModel = SpeechModel> = GenerateSpeechOptions<TModel>;

export interface SpeechOutput extends SpeechResult {
  input: string;
}

export interface ImageGenerationModelInput<TProviderOptions extends ProviderOptions = ProviderOptions>
  extends RetryOptions {
  prompt: string;
  images?: MediaInput[];
  count?: number;
  aspectRatio?: string;
  size?: string;
  negativePrompt?: string;
  outputMimeType?: string;
  providerOptions?: TProviderOptions;
}

export interface VideoGenerationModelInput<TProviderOptions extends ProviderOptions = ProviderOptions>
  extends RetryOptions {
  prompt: string;
  image?: MediaInput;
  count?: number;
  aspectRatio?: string;
  negativePrompt?: string;
  durationSeconds?: number;
  outputStorageUri?: string;
  pollIntervalMs?: number;
  providerOptions?: TProviderOptions;
}

export interface MusicGenerationModelInput<TProviderOptions extends ProviderOptions = ProviderOptions>
  extends RetryOptions {
  prompt: string;
  images?: MediaInput[];
  negativePrompt?: string;
  outputMimeType?: string;
  providerOptions?: TProviderOptions;
}

export type GenerateImageOptions<TModel extends ImageGenerationModel = ImageGenerationModel> =
  ImageGenerationModelInput<TModel extends ImageGenerationModel<infer TProviderOptions> ? TProviderOptions : ProviderOptions> & {
    model: TModel;
  };

export interface GenerateImageOutput extends ImageGenerationResult {
  prompt: string;
}

export type GenerateVideoOptions<TModel extends VideoGenerationModel = VideoGenerationModel> =
  VideoGenerationModelInput<TModel extends VideoGenerationModel<infer TProviderOptions> ? TProviderOptions : ProviderOptions> & {
    model: TModel;
  };

export interface GenerateVideoOutput extends VideoGenerationResult {
  prompt: string;
}

export type GenerateMusicOptions<TModel extends MusicGenerationModel = MusicGenerationModel> =
  MusicGenerationModelInput<TModel extends MusicGenerationModel<infer TProviderOptions> ? TProviderOptions : ProviderOptions> & {
    model: TModel;
  };

export interface GenerateMusicOutput extends MusicGenerationResult {
  prompt: string;
}

export type UploadFileOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  FileUploadInput & {
    provider: TProvider;
  };

export type GetFileOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  FileGetInput & {
    provider: TProvider;
  };

export type ListFilesOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  FileListInput & {
    provider: TProvider;
  };

export type DeleteFileOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  FileDeleteInput & {
    provider: TProvider;
  };

export type CreateFileSearchStoreOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  FileSearchStoreCreateInput & {
    provider: TProvider;
  };

export type UploadToFileSearchStoreOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  FileSearchStoreUploadInput & {
    provider: TProvider;
  };

export type ImportFileToFileSearchStoreOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  FileSearchStoreImportInput & {
    provider: TProvider;
  };

export type GetFileSearchStoreOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  FileSearchStoreGetInput & {
    provider: TProvider;
  };

export type ListFileSearchStoresOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  FileSearchStoreListInput & {
    provider: TProvider;
  };

export type DeleteFileSearchStoreOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  FileSearchStoreDeleteInput & {
    provider: TProvider;
  };

export type CreateContextCacheOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  ContextCacheCreateInput & {
    provider: TProvider;
  };

export type GetContextCacheOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  ContextCacheGetInput & {
    provider: TProvider;
  };

export type ListContextCachesOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  ContextCacheListInput & {
    provider: TProvider;
  };

export type DeleteContextCacheOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  ContextCacheDeleteInput & {
    provider: TProvider;
  };

export type CreateBatchOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  BatchCreateInput & {
    provider: TProvider;
  };

export type GetBatchOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  BatchGetInput & {
    provider: TProvider;
  };

export type ListBatchesOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  BatchListInput & {
    provider: TProvider;
  };

export type CancelBatchOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  BatchCancelInput & {
    provider: TProvider;
  };

export type DeleteBatchOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  BatchDeleteInput & {
    provider: TProvider;
  };

export type CreateInteractionOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  InteractionCreateInput & {
    provider: TProvider;
  };

export type GetInteractionOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  InteractionGetInput & {
    provider: TProvider;
  };

export type CancelInteractionOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  InteractionCancelInput & {
    provider: TProvider;
  };

export type DeleteInteractionOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  InteractionDeleteInput & {
    provider: TProvider;
  };

export type ResumeInteractionOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  InteractionResumeInput & {
    provider: TProvider;
  };

export type StreamInteractionOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  InteractionCreateInput & {
    provider: TProvider;
  };

export interface PredictionModelInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  instances?: unknown[];
  parameters?: Record<string, unknown>;
  body?: unknown;
  providerOptions?: TProviderOptions;
}

export interface PredictionOperationInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  name: string;
  providerOptions?: TProviderOptions;
}

export type PredictRawOptions<TModel extends PredictionModel = PredictionModel> =
  PredictionModelInput<TModel extends PredictionModel<infer TProviderOptions> ? TProviderOptions : ProviderOptions> & {
    model: TModel;
  };

export type PredictLongRunningOptions<TModel extends PredictionModel = PredictionModel> =
  PredictionModelInput<TModel extends PredictionModel<infer TProviderOptions> ? TProviderOptions : ProviderOptions> & {
    model: TModel;
  };

export type FetchPredictionOperationOptions<TModel extends PredictionModel = PredictionModel> =
  PredictionOperationInput<TModel extends PredictionModel<infer TProviderOptions> ? TProviderOptions : ProviderOptions> & {
    model: TModel;
  };

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

export interface UIMessageToolApprovalRequestChunk {
  type: "tool-approval-request";
  messageId: string;
  role: "assistant";
  approval: AgentApprovalRequest;
}

export interface UIMessageProviderDataChunk {
  type: "provider-data";
  messageId: string;
  role: "assistant";
  provider: string;
  data: JsonValue;
}

export interface UIMessageGeneratedMedia {
  data?: string;
  encoding?: "base64";
  uri?: string;
  mediaType: string;
  text?: string;
  providerMetadata?: Record<string, JsonValue>;
}

export interface UIMessageImageGenerationChunk {
  type: "image-generation";
  messageId: string;
  role: "assistant";
  provider: string;
  image: UIMessageGeneratedMedia;
  partial: boolean;
  id?: string;
  index?: number;
  providerMetadata?: Record<string, JsonValue>;
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

export interface UIAgentCompactionChunk {
  type: "agent-compaction";
  compaction: AgentCompactionRecord;
}

export interface UIAgentRunFinishChunk {
  type: "agent-run-finish";
  status: AgentStatus;
  state: AgentRunState;
}

export interface UISessionFinishChunk {
  type: "session-finish";
  sessionId: string;
  status: AgentStatus;
}

export type UIMessageChunk =
  | UIMessageTextChunk
  | UIMessageToolCallChunk
  | UIMessageToolResultChunk
  | UIMessageToolApprovalRequestChunk
  | UIMessageProviderDataChunk
  | UIMessageImageGenerationChunk
  | UIMessageFinishChunk
  | UIMessageErrorChunk
  | UIAgentRunStartChunk
  | UIAgentStepStartChunk
  | UIAgentStepFinishChunk
  | UIAgentApprovalRequestChunk
  | UIAgentApprovalResolvedChunk
  | UIAgentCompactionChunk
  | UIAgentRunFinishChunk
  | UISessionFinishChunk;

export interface EmbedInput {
  values: EmbedValue[];
}

export interface EmbedOptions extends RetryOptions {
  model: EmbeddingModel;
  value: EmbedValue | EmbedValue[];
}

export interface EmbedOutput extends EmbedResult {
  values: EmbedValue[];
}
