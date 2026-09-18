import type {
  JsonValue,
  ModelCapabilities,
  ProviderOptions,
  RetryOptions,
  TokenUsage
} from "./common.js";
import type {
  ModelMessage
} from "./messages.js";
import type {
  ToolCollection
} from "./model-tools.js";
import type {
  StreamEvent
} from "./stream.js";

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
