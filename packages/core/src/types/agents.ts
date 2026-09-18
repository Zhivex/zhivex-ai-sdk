import type {
  z
} from "zod";
import type {
  AgentApprovalRequest,
  AgentApprovalResponse,
  AgentStatus,
  AgentStoreScope,
  FinishReason,
  JsonValue,
  ProviderOptions,
  ReasoningConfig,
  RetryOptions,
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
  AgentExecutionEnvironment,
  LanguageModel,
  RealtimeConnectOptions,
  RealtimeEvent,
  RealtimeModel,
  RealtimeSession,
  RealtimeSessionConfig,
  ToolApprovalPolicy,
  ToolApprovalSigner,
  ToolCollection,
  ToolExecutionOptions
} from "./model-tools.js";
import type {
  StreamEvent
} from "./stream.js";
import type {
  ProviderOptionsOf
} from "./generation.js";
import type {
  AgentChildRun,
  AgentCompactionOptions,
  AgentCompactionRecord,
  AgentHandoff,
  AgentHarnessBinding,
  AgentRunError,
  AgentRunPolicy,
  AgentRunState,
  AgentStep,
  AgentTaskOutcome
} from "./agent-state.js";
import type {
  AgentMemoryStore,
  AgentRunStore
} from "./persistence.js";

/** Browser-facing execution summary. Never contains messages, tool arguments, scope, or credentials. */
export interface AgentRunView {
  runId: string;
  parentRunId?: string;
  agentId?: string;
  name?: string;
  status: AgentStatus;
  provider?: string;
  modelId?: string;
  currentStep: number;
  maxSteps: number;
  usage?: TokenUsage;
  budget?: { maxTotalTokens?: number; maxToolCalls?: number };
  toolCalls?: number;
  handoffToAgentId?: string;
  startedAt?: number;
  updatedAt?: number;
}

export interface AgentRunUpdateEvent {
  type: "agent-run-update";
  run: AgentRunView;
}

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
  | AgentRunUpdateEvent
  | StreamEvent
  | AgentRunStartEvent
  | AgentStepStartEvent
  | AgentStepFinishEvent
  | AgentApprovalRequestEvent
  | AgentApprovalResolvedEvent
  | AgentCompactionEvent
  | AgentRunFinishEvent;

export interface AgentTelemetryRunStartEvent {
  type: "run-start";
  runId: string;
  agentId?: string;
  agentName?: string;
  provider: string;
  modelId: string;
  maxSteps: number;
  startedAt?: number;
}

export interface AgentTelemetryStepStartEvent {
  type: "step-start";
  runId: string;
  agentId?: string;
  agentName?: string;
  stepIndex: number;
  startedAt?: number;
}

export interface AgentTelemetryStepFinishEvent {
  type: "step-finish";
  runId: string;
  agentId?: string;
  step: AgentStep;
}

export interface AgentTelemetryToolStartEvent {
  type: "tool-start";
  runId: string;
  agentId?: string;
  agentName?: string;
  stepIndex: number;
  toolCall: ToolCall;
  startedAt?: number;
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
  agentName?: string;
  status: AgentStatus;
  state: AgentRunState;
  finishedAt?: number;
}

export type AgentTelemetryEvent =
  | AgentTelemetryRunStartEvent
  | AgentTelemetryStepStartEvent
  | AgentTelemetryStepFinishEvent
  | AgentTelemetryToolStartEvent
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

export interface AgentTelemetryInvocationStart {
  runId: string;
  agentId?: string;
  agentName?: string;
  provider: string;
  modelId: string;
  maxSteps: number;
  startedAt: number;
}

export interface AgentTelemetryInvocationFinish {
  runId: string;
  agentId?: string;
  agentName?: string;
  status: AgentStatus;
  error?: Error;
  finishedAt: number;
}

export type AgentTelemetryObserver = ((
  event: AgentTelemetryEvent
) => void | Promise<void>) & {
  /** Starts an invocation boundary before context, store, lease, and preflight work. */
  startInvocation?(event: AgentTelemetryInvocationStart): void | Promise<void>;
  /** Closes that boundary even when setup fails before the normal run lifecycle starts. */
  finishInvocation?(event: AgentTelemetryInvocationFinish): void | Promise<void>;
  /** Runs work with the matching agent invocation span active when supported. */
  withRunContext?<T>(runId: string, callback: () => T | Promise<T>): Promise<T>;
  /** Runs work with the matching agent step span active when supported. */
  withStepContext?<T>(runId: string, stepIndex: number, callback: () => T | Promise<T>): Promise<T>;
};

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
  /** Human-readable, low-cardinality name. `id` remains the stable definition identifier. */
  name?: string;
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
  /** Human-readable, low-cardinality name. `id` remains the stable definition identifier. */
  name?: string;
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
  taskOutcome?: AgentTaskOutcome;
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
  error?: AgentRunError;
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
  /** Maximum active members. Omitted means all members may run concurrently. */
  maxConcurrency?: number;
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
  status: AgentStatus;
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
  error?: AgentRunError;
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
