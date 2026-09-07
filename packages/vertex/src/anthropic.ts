import { createAnthropicMessagesModel, type AnthropicLanguageModelOptions } from "@zhivex-ai/anthropic";
import {
  ProviderHTTPError,
  UnsupportedFeatureError,
  isCallableToolDefinition,
  readErrorBodyWithLimit,
  type ModelGenerateInput
} from "@zhivex-ai/core";

// Vertex's host contract is narrower than Anthropic's direct API.
const assertVertexClaudeInput = (input: ModelGenerateInput) => {
  if (Object.values(input.tools ?? {}).some((tool) => !isCallableToolDefinition(tool))) {
    throw new UnsupportedFeatureError("Claude on Vertex supports client tools only; hosted tools and remote MCP are not exposed.");
  }
  const options = input.providerOptions ?? {};
  for (const key of ["speed", "fallbacks", "midConversationToolChanges", "mcp_servers", "container", "context_management", "anthropic_beta", "stream"]) {
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

export const createVertexClaudeModel = (modelId: string, endpoint: string, fetcher: typeof globalThis.fetch) => {
  const model = createAnthropicMessagesModel({
    modelId,
    provider: "vertex",
    capabilities: {
      // Opus 4.1 has structured output on the direct API, but not on Vertex.
      structuredOutput: /^claude-(?:(?:opus|sonnet|haiku)-4-[5-9]|(?:opus|sonnet|haiku|fable|mythos)-[5-9])(?:[-@]|$)/.test(modelId),
      webSearch: false,
      agentCapabilities: {
        supportTier: "tier-b",
        toolChoiceNone: true,
        approvalRequests: false,
        hostedWebSearch: false,
        hostedFileSearch: false,
        remoteMcp: false,
        computerUse: false,
        codeExecution: false,
        toolsets: false
      }
    },
    transport: {
      async send(body, signal, withMcpToolset, withFilesApi, betas) {
        if (withMcpToolset || withFilesApi || betas.length) {
          throw new UnsupportedFeatureError("Claude on Vertex does not expose Anthropic API beta features, remote MCP, or Files API IDs.");
        }
        const { model: _model, ...request } = JSON.parse(body);
        const action = request.stream === true ? "streamRawPredict" : "rawPredict";
        const response = await fetcher(`${endpoint}:${action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          redirect: "error",
          signal,
          body: JSON.stringify({ ...request, anthropic_version: "vertex-2023-10-16" })
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
  return {
    provider: model.provider,
    modelId,
    capabilities: model.capabilities,
    async generate(input: ModelGenerateInput) {
      validate(input);
      return model.generate(input);
    },
    async stream(input: ModelGenerateInput) {
      validate(input);
      return model.stream!(input);
    }
  };
};
