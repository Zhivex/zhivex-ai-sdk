import { createAnthropicMessagesModel, type AnthropicLanguageModelOptions } from "@zhivex-ai/anthropic";
import {
  ProviderHTTPError,
  ConfigurationError,
  UnsupportedFeatureError,
  isCallableToolDefinition,
  readErrorBodyWithLimit,
  type ModelGenerateInput
} from "@zhivex-ai/core/provider";

export interface VertexClaudeOptions extends AnthropicLanguageModelOptions {
  /** Global-endpoint routing affinity for prompt cache reuse. */
  sessionId?: string;
  cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" };
}

const nativeTools = new Set([
  "web_search_20250305", "bash_20250124", "text_editor_20250124",
  "text_editor_20250429", "text_editor_20250728", "memory_20250818",
  "computer_20250124", "tool_search_tool_regex_20251119", "tool_search_tool_bm25_20251119", "browser_toolset_20260801"
]);
const vertexBetas = new Set(["computer-use-2025-01-24", "context-management-2025-06-27", "compact-2026-01-12"]);

// Vertex's host contract is narrower than Anthropic's direct API.
const assertVertexClaudeInput = (input: ModelGenerateInput) => {
  for (const tool of Object.values(input.tools ?? {})) if (!isCallableToolDefinition(tool)) {
    if ((tool.provider && !["vertex", "anthropic"].includes(tool.provider)) || !nativeTools.has(tool.type)) throw new UnsupportedFeatureError(`Claude on Vertex does not support native tool ${tool.type}.`);
  }
  const options = input.providerOptions ?? {};
  for (const key of ["speed", "fallbacks", "midConversationToolChanges", "mcp_servers", "container", "compaction", "anthropic_beta", "stream"]) {
    if (options[key] !== undefined) {
      throw new UnsupportedFeatureError(`Claude on Vertex does not expose providerOptions.${key}.`);
    }
  }
  if (input.messages.some((message) => message.parts.some((part) =>
    part.type === "file" && /^file_/i.test(part.data)
  ))) {
    throw new UnsupportedFeatureError("Claude on Vertex does not support Anthropic Files API IDs; supply inline document content.");
  }
};

const validateWireRequest = (request: any, modelId: string) => {
  for (const tool of request.tools ?? []) if (tool.type && !nativeTools.has(tool.type)) throw new UnsupportedFeatureError(`Claude on Vertex does not support native tool ${tool.type}.`);
  const visit = (value: any): void => {
    if (!value || typeof value !== "object") return;
    if (value.cache_control !== undefined) {
      const control = value.cache_control;
      if (!control || control.type !== "ephemeral" || (control.ttl !== undefined && !["5m", "1h"].includes(control.ttl))) throw new ConfigurationError("Claude cache_control requires ephemeral with a 5m or 1h TTL.");
      if (control.ttl === "1h" && /^claude-3-(?:7-sonnet|5-sonnet|opus)/.test(modelId)) throw new UnsupportedFeatureError("This Claude model on Vertex does not support a 1h cache TTL.");
    }
    // URL and Files API sources are not part of the Vertex Claude host contract.
    if (["image", "document"].includes(value.type) && ["url", "file"].includes(value.source?.type)) throw new UnsupportedFeatureError("Claude on Vertex requires inline image/document sources, not URL or Files API sources.");
    for (const child of Object.values(value)) visit(child);
  };
  visit(request);
};

export const createVertexClaudeModel = (modelId: string, endpoint: string, fetcher: typeof globalThis.fetch) => {
  const browserToolset = /^claude-(?:opus-4-8|(?:opus|sonnet|fable|mythos)-5(?:-1)?)(?:@|$)/.test(modelId);
  const model = createAnthropicMessagesModel({
    modelId,
    provider: "vertex",
    capabilities: {
      // Opus 4.1 has structured output on the direct API, but not on Vertex.
      structuredOutput: /^claude-(?:(?:opus|sonnet|haiku)-4-[5-9]|(?:opus|sonnet|haiku|fable|mythos)-[5-9])(?:[-@]|$)/.test(modelId),
      webSearch: true,
      agentCapabilities: {
        supportTier: "tier-b",
        toolChoiceNone: true,
        approvalRequests: false,
        hostedWebSearch: true,
        hostedFileSearch: false,
        remoteMcp: false,
        computerUse: true,
        codeExecution: false,
        toolsets: browserToolset
      }
    },
    transport: {
      async send(body, signal, withMcpToolset, withFilesApi, betas) {
        if (withMcpToolset || withFilesApi || betas.some((beta) => !vertexBetas.has(beta))) {
          throw new UnsupportedFeatureError("Claude on Vertex does not expose this beta feature, remote MCP, or Files API IDs.");
        }
        const { model: _model, sessionId, ...request } = JSON.parse(body);
        if (sessionId !== undefined && (typeof sessionId !== "string" || !sessionId.trim() || /[\r\n]/.test(sessionId))) throw new ConfigurationError("Vertex Claude sessionId must be a nonempty single-line string.");
        validateWireRequest(request, modelId);
        if (!browserToolset && request.tools?.some((tool: any) => tool.type === "browser_toolset_20260801")) throw new UnsupportedFeatureError(`Vertex Claude model "${modelId}" does not support the browser toolset.`);
        const betaFeatures = new Set(betas);
        if (request.context_management !== undefined) {
          const edits = request.context_management?.edits;
          if (!Array.isArray(edits) || !edits.length) throw new ConfigurationError("Vertex Claude context_management requires a nonempty edits array.");
          const seen = new Set<string>();
          for (const [index, edit] of edits.entries()) {
            if (!edit || !["compact_20260112", "clear_tool_uses_20250919", "clear_thinking_20251015"].includes(edit.type)) throw new UnsupportedFeatureError("Unsupported Vertex Claude context editing strategy.");
            if (seen.has(edit.type)) throw new ConfigurationError("Vertex Claude context editing strategies must not repeat.");
            seen.add(edit.type);
            if (edit.type === "clear_thinking_20251015" && index !== 0) throw new ConfigurationError("Claude thinking clearing must precede other context edits.");
            if (edit.type === "compact_20260112") {
              if (!/^claude-(?:(?:opus|sonnet)-4-[6-8]|(?:opus|sonnet|fable|mythos)-5(?:-1)?)(?:@|$)/.test(modelId)) throw new UnsupportedFeatureError(`Vertex Claude model "${modelId}" does not support automatic compaction.`);
              if (edit.trigger !== undefined && (edit.trigger.type !== "input_tokens" || !Number.isInteger(edit.trigger.value) || edit.trigger.value < 50_000)) throw new ConfigurationError("Claude compaction trigger requires at least 50000 input tokens.");
              betaFeatures.add("compact-2026-01-12");
            } else betaFeatures.add("context-management-2025-06-27");
          }
        }
        if (request.tools?.some((tool: any) => tool.type === "computer_20250124")) betaFeatures.add("computer-use-2025-01-24");
        const payload = JSON.stringify({ ...request, anthropic_version: "vertex-2023-10-16", ...(betaFeatures.size ? { anthropic_beta: [...betaFeatures] } : {}) });
        if (new TextEncoder().encode(payload).byteLength > 30_000_000) throw new ConfigurationError("Vertex Claude request exceeds the 30 MB payload limit.");
        const action = request.stream === true ? "streamRawPredict" : "rawPredict";
        const response = await fetcher(`${endpoint}:${action}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(sessionId ? { "X-Vertex-Ai-Session-Id": sessionId } : {}) },
          redirect: "error",
          signal,
          body: payload
        });
        if (!response.ok) {
          throw new ProviderHTTPError(`Vertex Claude request failed with status ${response.status}.`, response.status, {
            responseBody: await readErrorBodyWithLimit(response)
          });
        }
        return response;
      }
    }
  });
  const validate = (input: ModelGenerateInput) => {
    assertVertexClaudeInput(input);
    if (!model.capabilities.structuredOutput && (input.structuredOutput?.mode === "native" || (input.providerOptions as AnthropicLanguageModelOptions | undefined)?.output_config?.format)) {
      throw new UnsupportedFeatureError(`Claude on Vertex model "${modelId}" does not support native structured output.`);
    }
  };
  const prepare = (input: ModelGenerateInput): ModelGenerateInput => ({ ...input,
    ...(input.tools ? { tools: Object.fromEntries(Object.entries(input.tools).map(([key, tool]) => [key,
      !isCallableToolDefinition(tool) && tool.provider === "vertex" ? { ...tool, provider: "anthropic" } : tool])) } : {})
  });
  return {
    provider: model.provider,
    modelId,
    capabilities: model.capabilities,
    async generate(input: ModelGenerateInput) {
      validate(input);
      return model.generate(prepare(input));
    },
    async stream(input: ModelGenerateInput) {
      validate(input);
      return model.stream!(prepare(input));
    }
  };
};
