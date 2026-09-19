import type {
  z,
  ZodTypeAny
} from "zod";
import type {
  AgentStatus,
  AgentStoreScope,
  AudioFrame,
  JsonValue,
  MediaFrame,
  ModelCapabilities,
  ProviderOptions,
  ReasoningConfig,
  RetryOptions,
  StructuredOutputConfig
} from "./common.js";
import type {
  ModelMessage,
  ToolCall,
  ToolChoice,
  ToolExecutionResult
} from "./messages.js";
import type {
  GenerateResult,
  StreamEvent
} from "./stream.js";

export interface ToolExecutionOptions {
  parallel?: boolean;
  /** Only explicitly independent ordinary tools may overlap; all others form serial barriers. */
  independentOnly?: boolean;
  maxConcurrency?: number;
  timeoutMs?: number;
  stopOnError?: boolean;
  /** Return sanitized schema errors to the model; strict rejection is the default. maxSteps bounds corrections. */
  validationErrorMode?: "throw" | "tool-result";
  /** Recover only names absent from the exact registry; never resolves aliases or bypasses availability. */
  unknownToolMode?: "throw" | "tool-result";
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
  /** Human-readable, low-cardinality agent name used for telemetry. */
  agentName?: string;
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

export interface ModelGenerateInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  messages: ModelMessage[];
  /** Opt-in discriminated JSON tool outputs: { output } on success, { error } on failure.
   * Only use with models advertising toolHistory: "json"; legacy serialization is the default.
   */
  toolResultFormat?: "raw" | "envelope";
  tools?: ToolSet;
  toolChoice?: ToolChoice;
  toolExecution?: ToolExecutionOptions;
  temperature?: number;
  maxTokens?: number;
  reasoning?: ReasoningConfig;
  providerOptions?: TProviderOptions;
  structuredOutput?: StructuredOutputConfig;
}

export interface LanguageModel<TProviderOptions extends ProviderOptions = ProviderOptions> {
  readonly provider: string;
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;
  generate(input: ModelGenerateInput<TProviderOptions>): Promise<GenerateResult>;
  stream?(input: ModelGenerateInput<TProviderOptions>): Promise<AsyncIterable<StreamEvent>>;
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
  /** Backend execution is owned by the application, separately from speech. */
  delegation?: { type: "client" };
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
  /** Provider session timeline, not wall-clock time or playback completion. */
  startMs?: number;
  endMs?: number;
  itemId?: string;
  responseId?: string;
  providerMetadata?: Record<string, JsonValue>;
}

export interface RealtimeToolCallEvent {
  type: "realtime-tool-call";
  toolCall: ToolCall;
}

/** The provider no longer accepts results for these calls. Local side effects are not undone. */
export interface RealtimeToolCallCancellationEvent {
  type: "realtime-tool-call-cancellation";
  toolCallIds: string[];
}

export interface RealtimeDelegationEvent {
  type: "realtime-delegation";
  /** Opaque provider ID. A delegation does not contain task text or tool arguments. */
  delegationId: string;
  offsetMs?: number;
  providerMetadata?: Record<string, JsonValue>;
}

export interface RealtimeContextUpdate {
  kind: "instructions" | "context" | "commentary";
  content: string;
  /** Omit for session-wide context. Only known client delegation IDs are valid. */
  delegationId?: string;
  eventId?: string;
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
  | RealtimeDelegationEvent
  | RealtimeTextDeltaEvent
  | RealtimeAudioOutputEvent
  | RealtimeTranscriptEvent
  | RealtimeToolCallEvent
  | RealtimeToolCallCancellationEvent
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
  /** Aborts when the provider cancels this call, independently of event consumption. */
  toolCallSignal?(toolCallId: string): AbortSignal;
  appendContext?(update: RealtimeContextUpdate): Promise<void>;
  setInputMuted?(muted: boolean): Promise<void>;
  /** Cancel current provider inference without closing the session, when supported. */
  interrupt?(): Promise<void>;
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

export interface ToolDefinition<
  TSchema extends ZodTypeAny = any,
  TResult = JsonValue,
  TContext = any
> {
  name: string;
  /** Application assertion that this tool may overlap with other independent tools. */
  independent?: boolean;
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
