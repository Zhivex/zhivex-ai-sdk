import {
  ConfigurationError, UnsupportedFeatureError, createChatCompletionsModel,
  type LanguageModel, type ModelCapabilities, type ModelGenerateInput
} from "@zhivex-ai/core/provider";

import { vertexChatProfile } from "./chat-profiles.js";
import { normalizeVertexInlineThinking } from "./inline-thinking.js";

export interface VertexChatModelOptions {
  /** Deployed endpoint ID or full projects/.../locations/.../endpoints/... resource. */
  endpoint?: string;
  /** Explicit deployment capabilities. Only applies to self-deployed endpoints. */
  capabilities?: Partial<ModelCapabilities>;
}

export const isVertexChatModel = (id: string) => /^(?:xai|meta|deepseek-ai|qwen|zai-org|moonshot-?ai|minimaxai|openai|mistralai|ai21)\//.test(id) || /^google\/gemma/.test(id) || /^(?:grok-|mistral-|codestral|jamba-)/.test(id);

const normalizeId = (id: string) => {
  if (id === "moonshot-ai/kimi-k2-thinking-maas") return "moonshotai/kimi-k2-thinking-maas";
  if (id.includes("/")) return id;
  if (id.startsWith("grok-")) return `xai/${id}`;
  if (/^(?:mistral-|codestral)/.test(id)) return `mistralai/${id}`;
  if (id.startsWith("jamba-")) return `ai21/${id}`;
  return id;
};

export const createVertexChatModel = (
  requestedId: string,
  baseURL: string,
  fetcher: typeof globalThis.fetch,
  options: VertexChatModelOptions = {}
): LanguageModel => {
  const id = normalizeId(requestedId);
  if (!id || /[\\?#\s]/.test(id) || id.split("/").some((s) => !s || s === "." || s === "..")) throw new ConfigurationError("Invalid Vertex chat model ID.");
  if (!options.endpoint && !/^(?:xai\/grok-|meta\/llama-|deepseek-ai\/deepseek-|qwen\/qwen|zai-org\/glm-|moonshot-?ai\/kimi-|minimaxai\/minimax-|openai\/gpt-oss-|mistralai\/(?:mistral-|codestral)|ai21\/jamba-|google\/gemma-)/.test(id)) throw new ConfigurationError("Use a supported publisher/model ID or configure a self-deployed endpoint.");
  if (!options.endpoint && options.capabilities) throw new ConfigurationError("Capability overrides apply only to self-deployed endpoints.");
  if (!options.endpoint && /mistral-ocr/.test(id)) throw new UnsupportedFeatureError("Mistral OCR requires the document extraction API, not a chat model.");
  const [publisher, model] = id.split("/");
  const rawPublisher = !options.endpoint && ["mistralai", "ai21"].includes(publisher);
  const profile = vertexChatProfile(options.endpoint ? "" : id);
  const gptOss = profile.thinkingControl === "effort";
  const deepseekHybrid = profile.thinkingControl === "thinking";
  const templateThinking = profile.thinkingControl === "enable_thinking";
  const capabilities: ModelCapabilities = { ...profile.capabilities, ...(options.endpoint ? options.capabilities : {}) };
  let endpoint = `${baseURL}/endpoints/openapi/chat/completions`;
  if (options.endpoint) {
    const resource = options.endpoint.includes("/") ? options.endpoint : `endpoints/${options.endpoint}`;
    if (!/^(?:projects\/[^/]+\/locations\/[^/]+\/)?endpoints\/[^/]+$/.test(resource)
      || resource.split("/").some((segment) => /[\\?#\s]/.test(segment) || [".", ".."].includes(segment))) throw new ConfigurationError("Invalid Vertex deployed endpoint resource.");
    const prefix = resource.startsWith("projects/") ? baseURL.replace(/\/projects\/.*$/, "") : baseURL;
    endpoint = `${prefix}/${resource.split("/").map(encodeURIComponent).join("/")}/chat/completions`;
  }
  const prepare = (input: ModelGenerateInput): ModelGenerateInput => {
    const extra = { ...(input.providerOptions ?? {}) };
    if (rawPublisher && publisher === "mistralai" && extra.safe_prompt !== undefined) {
      throw new UnsupportedFeatureError("Mistral on Vertex does not support safe_prompt.");
    }
    let toolChoice = input.toolChoice;
    if (!options.endpoint && gptOss) {
      const choice = toolChoice ?? extra.tool_choice;
      if (choice !== undefined && choice !== "auto" && choice !== "none") throw new UnsupportedFeatureError("Vertex gpt-oss supports only auto or none tool choice, not required or named tools.");
      toolChoice = choice as "auto" | "none" | undefined;
      delete extra.tool_choice;
    }
    // gpt-oss currently rejects omitted choice with tools (host template error).
    // Google's Qwen serving guidance also calls for an explicit auto/none choice.
    if (!options.endpoint && (gptOss || publisher === "qwen") && toolChoice === undefined
      && extra.tool_choice === undefined && Object.keys(input.tools ?? {}).length) toolChoice = "auto";
    for (const key of ["apiMode", "betas", "mcp_servers", "web_search_options", "multi_agent", "previous_response_id"]) {
      if (extra[key] !== undefined) throw new UnsupportedFeatureError(`Vertex chat does not expose providerOptions.${key}.`);
    }
    const effort = input.reasoning?.effort ?? extra.reasoning_effort;
    if (input.reasoning?.budgetTokens !== undefined || input.reasoning?.mode !== undefined || input.reasoning?.context !== undefined) throw new UnsupportedFeatureError("Vertex partner chat does not expose reasoning budgets, mode or context controls.");
    if (effort !== undefined) {
      if (options.endpoint && capabilities.reasoning) {
        extra.reasoning_effort = effort;
      } else if (gptOss) {
        if (!["low", "medium", "high"].includes(String(effort))) throw new UnsupportedFeatureError("Vertex gpt-oss supports low, medium or high reasoning effort.");
        extra.reasoning_effort = effort;
      } else if (deepseekHybrid || templateThinking) {
        if (!["none", "low", "medium", "high"].includes(String(effort))) throw new UnsupportedFeatureError("This Vertex model supports enabling or disabling thinking, not this reasoning effort.");
        delete extra.reasoning_effort;
        extra.chat_template_kwargs = { ...(extra.chat_template_kwargs as Record<string, unknown> ?? {}), [deepseekHybrid ? "thinking" : "enable_thinking"]: effort !== "none" };
      } else throw new UnsupportedFeatureError(`Vertex model "${id}" does not support reasoning_effort; its thinking behavior is model-defined.`);
    }
    if (input.reasoning && !capabilities.reasoning) throw new UnsupportedFeatureError(`Vertex model "${id}" does not support reasoning.`);
    return { ...input, toolChoice, reasoning: undefined, providerOptions: extra };
  };
  const delegate = createChatCompletionsModel({
    provider: "vertex", modelId: id, capabilities, prepare,
    send: (body, signal) => {
      if (rawPublisher && publisher === "ai21" && body.stream && Array.isArray(body.tools) && body.tools.length) {
        throw new UnsupportedFeatureError("AI21 Jamba on Vertex does not support streaming requests with tools; use generate instead.");
      }
      const url = rawPublisher ? `${baseURL}/publishers/${publisher}/models/${encodeURIComponent(model)}:${body.stream ? "streamRawPredict" : "rawPredict"}` : endpoint;
      const request = { ...body };
      // Harmony's hosted serializer requires a string description even though
      // the shared callable-tool contract makes it optional.
      if (!options.endpoint && gptOss && Array.isArray(request.tools)) {
        request.tools = request.tools.map((tool: any) => ({ ...tool,
          function: { ...tool.function, description: tool.function.description ?? "" }
        }));
      }
      if (rawPublisher) {
        request.model = model.split("@")[0];
        delete request.stream_options;
        // Mistral's publisher contract calls forced callable-tool choice "any".
        if (publisher === "mistralai" && request.tool_choice === "required") request.tool_choice = "any";
      }
      return fetcher(url, { method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal, body: JSON.stringify(request) });
    }
  });
  const normalized = !options.endpoint && id === "minimaxai/minimax-m2-maas"
    ? normalizeVertexInlineThinking(delegate) : delegate;
  return { ...normalized, modelId: requestedId };
};
