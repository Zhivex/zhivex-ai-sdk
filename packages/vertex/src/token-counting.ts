import {
  ConfigurationError, ProviderHTTPError, readErrorBodyWithLimit, readJsonWithLimit,
  withRetry, withTimeoutSignal, type JsonValue, type RetryOptions
} from "@zhivex-ai/core/provider";

/** Native Claude message blocks, including tools, images and documents. */
export interface VertexClaudeTokenCountInput extends RetryOptions {
  modelId: string;
  messages: Array<{ role: "user" | "assistant"; content: string | Array<Record<string, JsonValue>> }>;
  system?: string | Array<Record<string, JsonValue>>;
  tools?: Array<Record<string, JsonValue>>;
  thinking?: Record<string, JsonValue>;
  toolChoice?: Record<string, JsonValue>;
}
export interface VertexClaudeTokenCountResult {
  inputTokens: number;
  rawResponse: unknown;
}
export interface VertexClaudeClient {
  countTokens(input: VertexClaudeTokenCountInput): Promise<VertexClaudeTokenCountResult>;
}

export const createVertexClaudeClient = (baseURL: string, fetcher: typeof globalThis.fetch, assertAccess: () => void): VertexClaudeClient => ({
  async countTokens(input) {
    assertAccess();
    if (!/^claude-[a-z0-9@.-]+$/.test(input.modelId)) throw new ConfigurationError("Vertex Claude token counting requires a Claude model ID.");
    if (!Array.isArray(input.messages) || !input.messages.length || input.messages.some((message) => !message || !["user", "assistant"].includes(message.role) || (typeof message.content !== "string" && !Array.isArray(message.content)))) throw new ConfigurationError("Vertex Claude token counting requires native Claude messages.");
    const body = JSON.stringify({ model: input.modelId, messages: input.messages, system: input.system,
      tools: input.tools, thinking: input.thinking, tool_choice: input.toolChoice });
    if (new TextEncoder().encode(body).byteLength > 30_000_000) throw new ConfigurationError("Vertex Claude token count request exceeds 30 MB.");
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(async () => {
        const result = await fetcher(`${baseURL}/publishers/anthropic/models/count-tokens:rawPredict`, {
          method: "POST", headers: { "content-type": "application/json" }, body, signal, redirect: "error"
        });
        if (!result.ok) throw new ProviderHTTPError(`Vertex Claude token counting failed with status ${result.status}.`, result.status, { responseBody: await readErrorBodyWithLimit(result) });
        return result;
      }, { ...input, abortSignal: signal });
      const result: any = await readJsonWithLimit(response, { maxBytes: 1024 * 1024 });
      if (!Number.isInteger(result?.input_tokens) || result.input_tokens < 0) throw new ConfigurationError("Vertex Claude returned an invalid token count.");
      return { inputTokens: result.input_tokens, rawResponse: result };
    } finally { cleanup(); }
  }
});

export interface VertexGeminiTokenCountInput extends RetryOptions {
  modelId: string;
  messages: import("@zhivex-ai/core/provider").ModelMessage[];
  system?: string;
  tools?: import("@zhivex-ai/core/provider").ToolCollection;
  generationConfig?: Record<string, JsonValue>;
}
export interface VertexGeminiTokenCountResult {
  inputTokens: number;
  totalBillableCharacters?: number;
  rawResponse: unknown;
}
export interface VertexGeminiClient {
  countTokens(input: VertexGeminiTokenCountInput): Promise<VertexGeminiTokenCountResult>;
}
