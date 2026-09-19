import { createOpenAI } from "@zhivex-ai/openai";
import {
  ConfigurationError, ProviderHTTPError, UnsupportedFeatureError, isCallableToolDefinition,
  type LanguageModel, type ModelGenerateInput, type ModelMessage, type StreamEvent
} from "@zhivex-ai/core/provider";
import { vertexChatProfile } from "./chat-profiles.js";

// Vertex's Grok Responses contract is stateless, regardless of direct xAI/OpenAI defaults.
// https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/grok/responses
const models = new Set([
  "xai/grok-4.6", "xai/grok-4.3", "xai/grok-4.20-reasoning", "xai/grok-4.20-non-reasoning",
  "xai/grok-4.1-fast-reasoning", "xai/grok-4.1-fast-non-reasoning"
]);
const remap = (message: ModelMessage, from: string, to: string): ModelMessage => ({
  ...message, parts: message.parts.map(part => part.type === "provider-data" && part.provider === from
    ? { ...part, provider: to } : part)
});
const prepare = (input: ModelGenerateInput): ModelGenerateInput => {
  const options = input.providerOptions ?? {};
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    if (key === "store" && value === false) continue;
    if (key === "parallel_tool_calls" && typeof value === "boolean") continue;
    if (key === "top_p" && typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) continue;
    throw new UnsupportedFeatureError(`Vertex Grok Responses does not support providerOptions.${key} with this value.`);
  }
  if (input.reasoning !== undefined) throw new UnsupportedFeatureError("Vertex Grok Responses thinking is model-defined; reasoning controls are not exposed.");
  for (const tool of Object.values(input.tools ?? {})) {
    if (!isCallableToolDefinition(tool)) throw new UnsupportedFeatureError("Vertex Grok Responses supports callable functions, not hosted tools.");
    if (Object.keys(tool.metadata ?? {}).some(key => key.startsWith("openai."))) throw new UnsupportedFeatureError("Vertex Grok Responses does not support OpenAI tool metadata.");
  }
  for (const message of input.messages) for (const part of message.parts) {
    if (!["text", "image", "tool-call", "tool-result", "provider-data"].includes(part.type)) {
      throw new UnsupportedFeatureError(`Vertex Grok Responses does not support ${part.type} input.`);
    }
    if (part.type === "provider-data" && part.provider !== "vertex") throw new UnsupportedFeatureError("Vertex Grok Responses requires Vertex provider-data history.");
    if (part.type === "tool-result" && part.toolResult.providerMetadata?.responsesToolType !== undefined) {
      throw new UnsupportedFeatureError("Vertex Grok Responses does not support hosted tool outputs.");
    }
  }
  return { ...input, messages: input.messages.map(message => {
    const mapped = remap(message, "vertex", "openai");
    // The transport recognizes OpenAI built-ins by name. On Vertex every local
    // result is a function_call_output, even functions named shell or computer.
    return { ...mapped, parts: mapped.parts.map(part => part.type === "tool-result"
      ? { ...part, toolResult: { ...part.toolResult, toolName: "vertex_function" } } : part) };
  }), providerOptions: { ...options, apiMode: "responses", store: false } };
};
const rethrow = (error: unknown): never => {
  if (error instanceof ProviderHTTPError) throw new ProviderHTTPError(`Vertex Responses request failed with status ${error.status}.`, error.status, {
    cause: error, responseBody: error.responseBody
  });
  throw error;
};

export const createVertexResponsesModel = (
  requestedId: string, baseURL: string, fetcher: typeof globalThis.fetch, allowUnsafeEndpoints?: boolean
): LanguageModel => {
  const modelId = requestedId.startsWith("grok-") ? `xai/${requestedId}` : requestedId;
  if (!models.has(modelId)) throw new ConfigurationError("Vertex Responses requires a supported xai/grok model ID.");
  if (!/\/projects\/[^/]+\/locations\/global$/.test(baseURL)) throw new ConfigurationError("Vertex Grok Responses requires a project-scoped global endpoint.");
  const endpoint = `${baseURL}/endpoints/openapi/responses`;
  const delegate = createOpenAI({
    // Authenticated Vertex fetch always replaces this transport-only placeholder.
    apiKey: "vertex-authenticated-transport", baseURL: `${baseURL}/endpoints/openapi`, allowUnsafeEndpoints,
    fetch: async (url, init) => {
      if (String(url) !== endpoint || init?.method !== "POST") throw new ConfigurationError("Unexpected Vertex Responses transport route.");
      return fetcher(url, { ...init, redirect: "error" });
    }
  })(modelId);
  return {
    provider: "vertex", modelId: requestedId,
    capabilities: { ...vertexChatProfile(modelId).capabilities, jsonMode: false },
    async generate(input) {
      const prepared = prepare(input);
      try {
        const result = await delegate.generate(prepared);
        return { ...result,
          ...(result.message ? { message: remap(result.message, "openai", "vertex") } : {}),
          ...(result.messages ? { messages: result.messages.map(message => remap(message, "openai", "vertex")) } : {}) };
      } catch (error) { return rethrow(error); }
    },
    async stream(input) {
      const prepared = prepare(input);
      let events: AsyncIterable<StreamEvent>;
      try { events = await delegate.stream!(prepared); } catch (error) { return rethrow(error); }
      return (async function* () {
        let finished = false;
        try {
          for await (const event of events) {
            if (event.type === "finish") finished = true;
            yield event.type === "provider-data" && event.provider === "openai"
              ? { ...event, provider: "vertex" } : event;
          }
          if (!finished) throw new ConfigurationError("Vertex Responses stream ended without a terminal response.");
        } catch (error) { rethrow(error); }
      })();
    }
  };
};
