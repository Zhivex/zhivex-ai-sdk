import type {
  ZodTypeAny
} from "zod";

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

export interface ModelCapabilities {
  /** Preserves complete callable tool history, including multiple results and error state.
   * json adapters must honor ModelGenerateInput.toolResultFormat = "envelope".
   */
  toolHistory?: "native" | "json";
  streaming: boolean;
  tools: boolean;
  structuredOutput: boolean;
  jsonMode: boolean;
  toolChoice: boolean;
  parallelToolCalls: boolean;
  /** Optional MIME allowlist for input attachments; wildcards such as image/* are allowed. */
  inputMediaTypes?: readonly string[];
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
    /** Continuous speech without authoritative response/turn completion events. */
    fullDuplex?: boolean;
    clientDelegation?: boolean;
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

/**
 * Provider-specific request fields. Known provider adapters expose narrower
 * generic option types. Arbitrary passthrough fields are Experimental; wrap
 * them with `experimentalRawProviderOptions()` so the dependency is explicit.
 */
export type ProviderOptions = Record<string, unknown>;

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

export type ProviderToolCallErrorReason =
  | "empty_arguments"
  | "invalid_json"
  | "arguments_too_large"
  | "incomplete_arguments"
  | "inconsistent_metadata"
  | "response_failed"
  | "response_incomplete"
  | "stream_truncated";

/**
 * Logical isolation boundary for durable agent data. Applications should use
 * one scope per tenant and, when memory must be private, per end user.
 */
export interface AgentStoreScope {
  tenantId: string;
  userId?: string;
  namespace?: string;
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
