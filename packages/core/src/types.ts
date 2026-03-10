import type { z, ZodTypeAny } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ModelMessage {
  role: MessageRole;
  content: string;
  toolCallId?: string;
  toolName?: string;
}

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

export interface ToolResult {
  toolCallId: string;
  toolName: string;
  output: JsonValue;
}

export interface StreamTextDeltaChunk {
  type: "text-delta";
  textDelta: string;
}

export interface StreamToolCallChunk {
  type: "tool-call";
  toolCall: ToolCall;
}

export interface StreamFinishChunk {
  type: "finish";
  finishReason?: string;
  usage?: TokenUsage;
}

export interface StreamErrorChunk {
  type: "error";
  error: Error;
}

export type StreamChunk =
  | StreamTextDeltaChunk
  | StreamToolCallChunk
  | StreamFinishChunk
  | StreamErrorChunk;

export interface GenerateResult {
  text: string;
  finishReason?: string;
  usage?: TokenUsage;
  toolCalls?: ToolCall[];
  rawResponse?: unknown;
}

export interface EmbedResult {
  embeddings: number[][];
  usage?: TokenUsage;
  rawResponse?: unknown;
}

export interface LanguageModel {
  readonly provider: string;
  readonly modelId: string;
  generate(input: ModelGenerateInput): Promise<GenerateResult>;
  stream?(input: ModelGenerateInput): Promise<AsyncIterable<StreamChunk>>;
}

export interface EmbeddingModel {
  readonly provider: string;
  readonly modelId: string;
  embed(input: EmbedInput): Promise<EmbedResult>;
}

export interface ProviderAdapter {
  readonly name: string;
  languageModel(modelId: string): LanguageModel;
  embeddingModel(modelId: string): EmbeddingModel;
}

export interface ToolDefinition<TSchema extends ZodTypeAny = ZodTypeAny, TResult = JsonValue> {
  name: string;
  description?: string;
  schema: TSchema;
  execute: (input: z.infer<TSchema>) => Promise<TResult> | TResult;
}

export type ToolSet = Record<string, ToolDefinition>;

export interface ModelGenerateInput {
  messages: ModelMessage[];
  tools?: ToolSet;
  temperature?: number;
  maxTokens?: number;
  providerOptions?: Record<string, unknown>;
}

export interface GenerateTextOptions {
  model: LanguageModel;
  prompt?: string;
  messages?: ModelMessage[];
  system?: string;
  tools?: ToolSet;
  maxSteps?: number;
  temperature?: number;
  maxTokens?: number;
  providerOptions?: Record<string, unknown>;
}

export interface GenerateTextStep {
  request: ModelGenerateInput;
  response: GenerateResult;
}

export interface GenerateTextOutput {
  text: string;
  finishReason?: string;
  usage?: TokenUsage;
  steps: GenerateTextStep[];
  messages: ModelMessage[];
  toolResults: ToolResult[];
}

export interface GenerateObjectOptions<TSchema extends ZodTypeAny> extends GenerateTextOptions {
  schema: TSchema;
}

export interface GenerateObjectOutput<TSchema extends ZodTypeAny> extends GenerateTextOutput {
  object: z.infer<TSchema>;
}

export interface EmbedInput {
  values: string[];
}

export interface EmbedOptions {
  model: EmbeddingModel;
  value: string | string[];
}

export interface EmbedOutput extends EmbedResult {
  values: string[];
}
