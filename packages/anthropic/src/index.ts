import { toJSONSchema } from "zod";

import {
  ConfigurationError,
  ProviderHTTPError,
  UnsupportedFeatureError,
  ValidationError,
  createProviderAdapter,
  isCallableToolDefinition,
  hostedTool,
  normalizeFinishReason,
  providerDataPart,
  streamSSE,
  withRetry,
  withTimeoutSignal,
  type CallableProviderAdapter,
  type GenerateResult,
  type JsonValue,
  type LanguageModel,
  type ModelCapabilities,
  type ModelGenerateInput,
  type ModelMessage,
  type ProviderAdapter,
  type StreamEvent
} from "@zhivex-ai/core";

export interface AnthropicProviderOptions {
  apiKey?: string;
  baseURL?: string;
  anthropicVersion?: string;
  fetch?: typeof globalThis.fetch;
}

export interface AnthropicLanguageModelOptions {
  speed?: "standard" | "fast";
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  metadata?: Record<string, unknown>;
  tool_choice?: { type: "auto" | "none" | "any" | "tool"; name?: string };
  thinking?: AnthropicThinkingConfig;
  output_config?: AnthropicOutputConfig;
  fallbacks?: AnthropicFallbackConfig[] | "default";
  /** Additional Anthropic beta feature names to send through the anthropic-beta header. */
  betas?: string[];
  /**
   * Preserves prompt-cache prefixes when an application changes its tool list between turns.
   * Currently supported only by Claude Opus 5.
   */
  midConversationToolChanges?: boolean;
  [key: string]: unknown;
}

export interface AnthropicThinkingConfig {
  type: "adaptive" | "disabled" | "enabled";
  budget_tokens?: number;
  display?: "omitted" | "summarized";
}

export interface AnthropicOutputConfig {
  effort?: "high" | "low" | "max" | "medium" | "xhigh";
  format?: {
    type: "json_schema";
    schema: Record<string, unknown>;
  };
  task_budget?: {
    type: "tokens";
    total: number;
    remaining?: number;
  };
  [key: string]: unknown;
}

export interface AnthropicFallbackConfig {
  model: string;
  max_tokens?: number;
  thinking?: AnthropicThinkingConfig;
}

interface MappedAnthropicReasoning {
  thinking?: AnthropicThinkingConfig;
  output_config?: AnthropicOutputConfig;
}

const capabilities: ModelCapabilities = {
  streaming: true,
  tools: true,
  structuredOutput: false,
  jsonMode: false,
  toolChoice: true,
  parallelToolCalls: true,
  vision: true,
  files: true,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
  reasoning: true,
  webSearch: true,
  agentCapabilities: {
    supportTier: "tier-b",
    toolChoiceNone: true,
    approvalRequests: false,
    hostedWebSearch: true,
    hostedFileSearch: false,
    remoteMcp: false,
    computerUse: false,
    codeExecution: true,
    toolsets: true
  }
};

const normalizeModelId = (modelId: string) => modelId.trim().toLowerCase();
const FAST_MODE_BETA = "fast-mode-2026-02-01";
const TASK_BUDGETS_BETA = "task-budgets-2026-03-13";
const SERVER_SIDE_FALLBACK_LIST_BETA = "server-side-fallback-2026-06-01";
const SERVER_SIDE_FALLBACK_DEFAULT_BETA = "server-side-fallback-2026-07-01";
const MID_CONVERSATION_TOOL_CHANGES_BETA = "mid-conversation-tool-changes-2026-07-01";

const isClaudeOpus45Model = (modelId: string) => /^claude-opus-4-5(?:[-@]|$)/.test(normalizeModelId(modelId));

const isClaudeOpus46Model = (modelId: string) => /^claude-opus-4-6(?:[-@]|$)/.test(normalizeModelId(modelId));

const isClaudeSonnet46Model = (modelId: string) => /^claude-sonnet-4-6(?:[-@]|$)/.test(normalizeModelId(modelId));

const isClaudeSonnet5Model = (modelId: string) => /^claude-sonnet-5(?:[-@]|$)/.test(normalizeModelId(modelId));

const isClaudeOpus5Model = (modelId: string) => /^claude-opus-5(?:[-@]|$)/.test(normalizeModelId(modelId));

const isClaudeOpus47OrLaterModel = (modelId: string) =>
  /^(?:claude-opus-4-(?:7|8|9)|claude-opus-[5-9])(?:[-@]|$)/.test(normalizeModelId(modelId));

const isClaudeOpus48OrLaterModel = (modelId: string) =>
  /^(?:claude-opus-4-(?:8|9)|claude-opus-[5-9])(?:[-@]|$)/.test(normalizeModelId(modelId));

const isClaudeFable5Model = (modelId: string) => /^claude-fable-5(?:[-@]|$)/.test(normalizeModelId(modelId));

const isClaudeMythos5Model = (modelId: string) => /^claude-mythos-5(?:[-@]|$)/.test(normalizeModelId(modelId));

const isClaudeMythosClass5Model = (modelId: string) => isClaudeFable5Model(modelId) || isClaudeMythos5Model(modelId);

const requiresAnthropicAdaptiveThinking = (modelId: string) => isClaudeMythosClass5Model(modelId);

const supportsAnthropicModernControls = (modelId: string) =>
  isClaudeOpus47OrLaterModel(modelId) || isClaudeSonnet5Model(modelId) || isClaudeMythosClass5Model(modelId);

const supportsAnthropicFastMode = (modelId: string) =>
  /^(?:claude-opus-4-(?:7|8)|claude-opus-5)(?:[-@]|$)/.test(normalizeModelId(modelId));

const supportsAnthropicTaskBudgets = (modelId: string) =>
  /^(?:claude-opus-4-(?:7|8)|claude-opus-5)(?:[-@]|$)/.test(normalizeModelId(modelId)) ||
  isClaudeMythosClass5Model(modelId);

const supportsMidConversationSystemMessages = (modelId: string) =>
  isClaudeOpus48OrLaterModel(modelId) || isClaudeSonnet5Model(modelId) || isClaudeMythosClass5Model(modelId);

const anthropicReasoningEfforts = (
  modelId: string
): NonNullable<ModelCapabilities["reasoningEfforts"]> | undefined => {
  if (isClaudeMythosClass5Model(modelId)) {
    return ["low", "medium", "high", "xhigh", "max"];
  }

  if (isClaudeOpus47OrLaterModel(modelId) || isClaudeSonnet5Model(modelId)) {
    return ["none", "low", "medium", "high", "xhigh", "max"];
  }

  if (isClaudeOpus46Model(modelId) || isClaudeSonnet46Model(modelId)) {
    return ["none", "low", "medium", "high", "max"];
  }

  if (isClaudeOpus45Model(modelId)) {
    return ["none", "low", "medium", "high"];
  }

  return undefined;
};

const supportsAdaptiveThinking = (modelId: string) =>
  isClaudeOpus46Model(modelId) ||
  isClaudeSonnet46Model(modelId) ||
  isClaudeOpus47OrLaterModel(modelId) ||
  isClaudeSonnet5Model(modelId) ||
  isClaudeMythosClass5Model(modelId);

const supportsAnthropicFiles = (modelId: string) => {
  const normalized = normalizeModelId(modelId);
  return (
    /^claude-3-[5-9](?:[-@]|$)/.test(normalized) ||
    /^claude-(?:opus|sonnet|haiku)-4(?:[-@]|$)/.test(normalized) ||
    /^claude-(?:opus|sonnet|haiku)-5(?:[-@]|$)/.test(normalized) ||
    isClaudeMythosClass5Model(normalized)
  );
};

const supportsAnthropicStructuredOutput = (modelId: string) => {
  const normalized = normalizeModelId(modelId);
  return (
    /^claude-opus-4-(?:1|[5-9])(?:[-@]|$)/.test(normalized) ||
    /^claude-sonnet-4-(?:5|6)(?:[-@]|$)/.test(normalized) ||
    /^claude-haiku-4-5(?:[-@]|$)/.test(normalized) ||
    /^claude-(?:opus|sonnet)-5(?:[-@]|$)/.test(normalized) ||
    isClaudeMythosClass5Model(normalized)
  );
};

const rejectsAssistantPrefill = (modelId: string) => {
  const normalized = normalizeModelId(modelId);
  return (
    /^(?:claude-opus-4-(?:[6-9])|claude-opus-[5-9])(?:[-@]|$)/.test(normalized) ||
    isClaudeSonnet46Model(normalized) ||
    isClaudeSonnet5Model(normalized) ||
    isClaudeMythosClass5Model(normalized)
  );
};

const modelCapabilities = (modelId: string): ModelCapabilities => ({
  ...capabilities,
  structuredOutput: supportsAnthropicStructuredOutput(modelId),
  files: supportsAnthropicFiles(modelId),
  reasoningEfforts: anthropicReasoningEfforts(modelId)
});

const isAnthropicFileId = (value: string) => /^file_[a-z0-9]+$/i.test(value);

const isHttpUrl = (value: string) => /^https?:\/\//i.test(value);

const mergeOptionalObjects = <T extends object>(base?: T, override?: T): T | undefined =>
  base || override ? ({ ...(base ?? {}), ...(override ?? {}) } as T) : undefined;

const mergeThinkingConfig = (
  base?: AnthropicThinkingConfig,
  override?: AnthropicThinkingConfig
): AnthropicThinkingConfig | undefined => {
  const merged = mergeOptionalObjects(base, override);
  if (merged && merged.type !== "enabled") {
    delete merged.budget_tokens;
  }
  return merged;
};

const definedNumber = (value: unknown) => (typeof value === "number" ? value : undefined);

const mapAnthropicUsage = (usage: any): GenerateResult["usage"] | undefined => {
  if (!usage) {
    return undefined;
  }

  const uncachedInputTokens = definedNumber(usage.input_tokens);
  const cachedInputTokens = definedNumber(usage.cache_read_input_tokens);
  const cacheWriteTokens = definedNumber(usage.cache_creation_input_tokens);
  const outputTokens = definedNumber(usage.output_tokens);
  const inputTokens =
    uncachedInputTokens === undefined &&
    cachedInputTokens === undefined &&
    cacheWriteTokens === undefined
      ? undefined
      : (uncachedInputTokens ?? 0) + (cachedInputTokens ?? 0) + (cacheWriteTokens ?? 0);

  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens: definedNumber(usage.output_tokens_details?.thinking_tokens),
    totalTokens:
      inputTokens === undefined && outputTokens === undefined
        ? undefined
        : (inputTokens ?? 0) + (outputTokens ?? 0),
    speed: usage.speed
  };
};

const mergeAnthropicUsage = (
  previous: GenerateResult["usage"],
  next: GenerateResult["usage"]
): GenerateResult["usage"] => {
  const merged = {
    ...(previous ?? {}),
    ...Object.fromEntries(Object.entries(next ?? {}).filter(([, value]) => value !== undefined))
  };

  return {
    ...merged,
    totalTokens:
      merged.inputTokens === undefined && merged.outputTokens === undefined
        ? undefined
        : (merged.inputTokens ?? 0) + (merged.outputTokens ?? 0)
  };
};

const parseJson = async (response: Response) => {
  if (!response.ok) {
    const body = await response.text();
    throw new ProviderHTTPError(`Anthropic request failed with status ${response.status}.`, response.status, {
      responseBody: body
    });
  }
  return response.json();
};

const mapFilePart = (modelId: string, part: Extract<ModelMessage["parts"][number], { type: "file" }>) => {
  if (!supportsAnthropicFiles(modelId)) {
    throw new UnsupportedFeatureError(`Model "anthropic/${modelId}" does not support file inputs.`);
  }

  if (part.mediaType === "application/pdf") {
    return {
      type: "document",
      source: isAnthropicFileId(part.data)
        ? {
            type: "file",
            file_id: part.data
          }
        : isHttpUrl(part.data)
          ? {
              type: "url",
              url: part.data
            }
          : {
              type: "base64",
              media_type: part.mediaType,
              data: part.data
            },
      ...(part.filename ? { title: part.filename } : {})
    };
  }

  if (part.mediaType === "text/plain") {
    return {
      type: "document",
      source: isAnthropicFileId(part.data)
        ? {
            type: "file",
            file_id: part.data
          }
        : isHttpUrl(part.data)
          ? (() => {
              throw new UnsupportedFeatureError(
                'Provider "anthropic" does not support URL-based "text/plain" document inputs.'
              );
            })()
          : {
              type: "text",
              media_type: part.mediaType,
              data: part.data
            },
      ...(part.filename ? { title: part.filename } : {})
    };
  }

  throw new UnsupportedFeatureError(
    `Provider "anthropic" only supports "application/pdf" and "text/plain" file inputs in the shared file mapping. Received "${part.mediaType}".`
  );
};

const mapBlockParts = (modelId: string, message: ModelMessage) =>
  message.parts.map((part) => {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text };
      case "image":
        return {
          type: "image",
          source: {
            type: "url",
            url: part.image
          }
        };
      case "file":
        return mapFilePart(modelId, part);
      case "tool-call":
        return {
          type: "tool_use",
          id: part.toolCall.id,
          name: part.toolCall.name,
          input: part.toolCall.input
        };
      case "tool-result":
        return {
          type: "tool_result",
          tool_use_id: part.toolResult.toolCallId,
          content: JSON.stringify(part.toolResult.isError ? part.toolResult.error : part.toolResult.output),
          is_error: part.toolResult.isError
        };
      case "provider-data":
        if (
          part.provider === "anthropic" &&
          typeof part.data === "object" &&
          part.data !== null &&
          !Array.isArray(part.data)
        ) {
          return part.data;
        }
        return {
          type: "text",
          text: JSON.stringify(part)
        };
      default:
        return {
          type: "text",
          text: JSON.stringify(part)
        };
    }
  });

const textFromSystemMessage = (message: ModelMessage) =>
  message.parts
    .filter((part): part is Extract<ModelMessage["parts"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");

const contentFromSystemMessage = (modelId: string, message: ModelMessage) =>
  message.parts.every((part) => part.type === "text")
    ? textFromSystemMessage(message)
    : mapBlockParts(modelId, message);

const leadingSystemMessages = (messages: ModelMessage[]) => {
  const firstNonSystemIndex = messages.findIndex((message) => message.role !== "system");
  return messages.slice(0, firstNonSystemIndex === -1 ? messages.length : firstNonSystemIndex);
};

const systemPromptFromMessages = (modelId: string, messages: ModelMessage[]) => {
  const systemMessages = supportsMidConversationSystemMessages(modelId)
    ? leadingSystemMessages(messages)
    : messages.filter((message) => message.role === "system");

  return systemMessages
    .flatMap((message) => message.parts)
    .filter((part): part is Extract<ModelMessage["parts"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
};

const mapMessages = (modelId: string, messages: ModelMessage[]) =>
  messages
    .filter((message, index) => {
      if (message.role !== "system") {
        return true;
      }

      if (!supportsMidConversationSystemMessages(modelId)) {
        return false;
      }

      const firstNonSystemIndex = messages.findIndex((candidate) => candidate.role !== "system");
      return firstNonSystemIndex !== -1 && index > firstNonSystemIndex;
    })
    .map((message, index, mappedMessages) => {
      if (message.role === "system") {
        const previousNonSystemMessage = mappedMessages
          .slice(0, index)
          .reverse()
          .find((candidate) => candidate.role !== "system");

        if (previousNonSystemMessage?.role !== "user") {
          throw new ValidationError(
            'Provider "anthropic" only supports mid-conversation system messages immediately after a user turn on Claude Opus 4.8 or later, Claude Sonnet 5, Claude Fable 5, or Claude Mythos 5.'
          );
        }

        return {
          role: "system",
          content: contentFromSystemMessage(modelId, message)
        };
      }

      if (message.role === "tool") {
        return {
          role: "user",
          content: mapBlockParts(modelId, message)
        };
      }

      return {
        role: message.role === "assistant" ? "assistant" : "user",
        content: mapBlockParts(modelId, message)
      };
    });

const mapTools = (tools: ModelGenerateInput["tools"]) =>
  tools
    ? Object.values(tools).map((tool) => {
        if (isCallableToolDefinition(tool)) {
          return {
            name: tool.name,
            description: tool.description,
            input_schema: toJSONSchema(tool.schema)
          };
        }

        if (tool.provider && tool.provider !== "anthropic") {
          throw new UnsupportedFeatureError(
            `Provider "anthropic" does not support hosted tools declared for provider "${tool.provider}".`
          );
        }

        if (tool.type === "mcp_toolset") {
          const config = tool.config as AnthropicMcpToolsetConfig | undefined;
          if (!config?.server?.name) {
            throw new UnsupportedFeatureError('Provider "anthropic" requires a named MCP server.');
          }

          return {
            type: "mcp_toolset",
            mcp_server_name: config.server.name,
            ...(config.default_config ? { default_config: config.default_config } : {}),
            ...(config.configs ? { configs: config.configs } : {}),
            ...(config.cache_control ? { cache_control: config.cache_control } : {})
          };
        }

        return {
          type: tool.type,
          name: tool.name,
          ...(tool.config && typeof tool.config === "object" ? tool.config : {})
        };
      })
    : undefined;

const mapMcpServers = (tools: ModelGenerateInput["tools"]) => {
  if (!tools) {
    return undefined;
  }

  const servers = new Map<string, AnthropicMcpServerConfig>();

  for (const tool of Object.values(tools)) {
    if (isCallableToolDefinition(tool)) {
      continue;
    }

    if (tool.provider && tool.provider !== "anthropic") {
      throw new UnsupportedFeatureError(
        `Provider "anthropic" does not support hosted tools declared for provider "${tool.provider}".`
      );
    }

    if (tool.type !== "mcp_toolset") {
      continue;
    }

    const config = tool.config as AnthropicMcpToolsetConfig | undefined;
    if (!config?.server?.name || !config.server.url) {
      throw new UnsupportedFeatureError('Provider "anthropic" requires MCP toolsets to declare "server.name" and "server.url".');
    }

    const normalizedServer = {
      type: config.server.type ?? "url",
      url: config.server.url,
      name: config.server.name,
      ...(config.server.authorization_token ? { authorization_token: config.server.authorization_token } : {})
    } satisfies AnthropicMcpServerConfig;

    const existing = servers.get(normalizedServer.name);
    if (existing && JSON.stringify(existing) !== JSON.stringify(normalizedServer)) {
      throw new UnsupportedFeatureError(`Provider "anthropic" received conflicting MCP server definitions for "${normalizedServer.name}".`);
    }

    servers.set(normalizedServer.name, normalizedServer);
  }

  return servers.size ? Array.from(servers.values()) : undefined;
};

const mapToolChoice = (toolChoice: ModelGenerateInput["toolChoice"]) => {
  if (!toolChoice || toolChoice === "auto") {
    return undefined;
  }

  if (toolChoice === "none") {
    return {
      type: "none"
    };
  }

  if (toolChoice === "required") {
    return {
      type: "any"
    };
  }

  return {
    type: "tool",
    name: toolChoice.toolName
  };
};

const mapReasoning = (modelId: string, input: ModelGenerateInput): MappedAnthropicReasoning | undefined => {
  if (!input.reasoning) {
    return undefined;
  }

  const { effort, budgetTokens } = input.reasoning;

  if (effort === "minimal") {
    throw new UnsupportedFeatureError('Provider "anthropic" does not support "reasoning.effort=minimal".');
  }

  if (effort === "none") {
    if (budgetTokens !== undefined) {
      throw new ValidationError(
        'Provider "anthropic" cannot combine "reasoning.effort=none" with "reasoning.budgetTokens".'
      );
    }

    if (requiresAnthropicAdaptiveThinking(modelId)) {
      throw new UnsupportedFeatureError(
        'Provider "anthropic" does not support disabling thinking for Claude Fable 5 or Claude Mythos 5.'
      );
    }

    return supportsAdaptiveThinking(modelId)
      ? {
          thinking: {
            type: "disabled"
          } satisfies AnthropicThinkingConfig
        }
      : undefined;
  }

  const supportedEfforts = anthropicReasoningEfforts(modelId);
  if (effort !== undefined && !supportedEfforts?.includes(effort)) {
    throw new UnsupportedFeatureError(
      `Provider "anthropic" does not support "reasoning.effort=${effort}" for model "${modelId}".`
    );
  }

  if (budgetTokens !== undefined && supportsAnthropicModernControls(modelId)) {
    throw new UnsupportedFeatureError(
      'Provider "anthropic" does not support "reasoning.budgetTokens" for Claude Opus 4.7 or later, Claude Sonnet 5, Claude Fable 5, or Claude Mythos 5; use "reasoning.effort" instead.'
    );
  }

  const thinking =
    budgetTokens !== undefined
      ? ({
          type: "enabled",
          budget_tokens: budgetTokens
        } satisfies AnthropicThinkingConfig)
      : supportsAdaptiveThinking(modelId) && effort !== undefined && !requiresAnthropicAdaptiveThinking(modelId)
        ? ({
            type: "adaptive"
          } satisfies AnthropicThinkingConfig)
        : undefined;

  return {
    ...(thinking ? { thinking } : {}),
    ...(effort !== undefined
      ? {
          output_config: {
            effort
          } satisfies AnthropicOutputConfig
        }
      : {})
  };
};

const parseAssistantMessage = (json: any): ModelMessage => ({
  role: "assistant",
  parts:
    json.content?.map((block: any) => {
      if (block.type === "text") {
        return { type: "text", text: block.text } as const;
      }

      if (block.type === "tool_use") {
        return {
          type: "tool-call" as const,
          toolCall: {
            id: block.id,
            name: block.name,
            input: block.input
          }
        };
      }

      if (typeof block?.type === "string") {
        return providerDataPart("anthropic", block as JsonValue);
      }

      return { type: "text", text: JSON.stringify(block) } as const;
    }) ?? []
});

const assertAnthropicRequestCompatibility = (
  modelId: string,
  input: ModelGenerateInput,
  thinking: AnthropicThinkingConfig | undefined,
  outputConfig: AnthropicOutputConfig | undefined,
  providerOptions: AnthropicLanguageModelOptions,
  betas: string[],
  midConversationToolChanges: boolean
) => {
  if (supportsAnthropicModernControls(modelId) && thinking?.type === "enabled") {
    throw new UnsupportedFeatureError(
      'Provider "anthropic" does not support manual "thinking.enabled + budget_tokens" for Claude Opus 4.7 or later, Claude Sonnet 5, Claude Fable 5, or Claude Mythos 5; use adaptive thinking and "output_config.effort" instead.'
    );
  }

  if (requiresAnthropicAdaptiveThinking(modelId) && thinking?.type === "disabled") {
    throw new UnsupportedFeatureError(
      'Provider "anthropic" does not support "thinking.disabled" for Claude Fable 5 or Claude Mythos 5; omit "thinking" or use "thinking.display" with adaptive thinking.'
    );
  }

  if (thinking?.type === "disabled" && thinking.display !== undefined) {
    throw new ValidationError(
      'Provider "anthropic" cannot combine "thinking.disabled" with "thinking.display".'
    );
  }

  const effort = outputConfig?.effort;
  const supportedEfforts = anthropicReasoningEfforts(modelId);
  if (effort !== undefined && !supportedEfforts?.includes(effort)) {
    throw new UnsupportedFeatureError(
      `Provider "anthropic" does not support "output_config.effort=${effort}" for model "${modelId}".`
    );
  }

  if (isClaudeOpus5Model(modelId) && thinking?.type === "disabled" && (effort === "xhigh" || effort === "max")) {
    throw new ValidationError(
      `Provider "anthropic" cannot combine "thinking.disabled" with "output_config.effort=${effort}" for Claude Opus 5.`
    );
  }

  if (
    (thinking?.type === "enabled" || thinking?.type === "adaptive") &&
    input.temperature !== undefined &&
    input.temperature !== 1
  ) {
    throw new UnsupportedFeatureError(
      'Provider "anthropic" only supports the default "temperature=1" when thinking is enabled or adaptive.'
    );
  }

  if (supportsAnthropicModernControls(modelId)) {
    if (input.temperature !== undefined && input.temperature !== 1) {
      throw new UnsupportedFeatureError(
        'Provider "anthropic" only supports the default "temperature=1" for Claude Opus 4.7 or later, Claude Sonnet 5, Claude Fable 5, or Claude Mythos 5.'
      );
    }

    if (
      (providerOptions.top_p !== undefined &&
        (!Number.isFinite(providerOptions.top_p) ||
          providerOptions.top_p < 0.99 ||
          providerOptions.top_p > 1)) ||
      providerOptions.top_k !== undefined
    ) {
      throw new UnsupportedFeatureError(
        'Provider "anthropic" only supports default sampling controls (top_p >= 0.99 and no top_k) for Claude Opus 4.7 or later, Claude Sonnet 5, Claude Fable 5, or Claude Mythos 5.'
      );
    }
  }

  if (
    rejectsAssistantPrefill(modelId) &&
    input.messages.at(-1)?.role === "assistant"
  ) {
    throw new UnsupportedFeatureError(
      `Provider "anthropic" does not support assistant prefill for model "${modelId}".`
    );
  }

  if (providerOptions.speed === "fast" && !supportsAnthropicFastMode(modelId)) {
    throw new UnsupportedFeatureError(
      `Provider "anthropic" does not support fast mode for model "${modelId}".`
    );
  }

  const taskBudget = outputConfig?.task_budget;
  if (taskBudget) {
    if (!supportsAnthropicTaskBudgets(modelId)) {
      throw new UnsupportedFeatureError(
        `Provider "anthropic" does not support task budgets for model "${modelId}".`
      );
    }
    if (taskBudget.type !== "tokens" || !Number.isInteger(taskBudget.total) || taskBudget.total < 20_000) {
      throw new ValidationError(
        'Provider "anthropic" requires "output_config.task_budget.total" to be an integer of at least 20000 tokens.'
      );
    }
    if (
      taskBudget.remaining !== undefined &&
      (!Number.isInteger(taskBudget.remaining) ||
        taskBudget.remaining < 0 ||
        taskBudget.remaining > taskBudget.total)
    ) {
      throw new ValidationError(
        'Provider "anthropic" requires "output_config.task_budget.remaining" to be an integer between 0 and total.'
      );
    }
  }

  const fallbacks = providerOptions.fallbacks;
  if (fallbacks === "default" && !isClaudeOpus5Model(modelId)) {
    throw new UnsupportedFeatureError(
      'Provider "anthropic" only supports managed "fallbacks=default" for Claude Opus 5.'
    );
  }

  if (Array.isArray(fallbacks)) {
    if (fallbacks.length === 0 || fallbacks.length > 3) {
      throw new ValidationError(
        'Provider "anthropic" requires between one and three server-side fallback models.'
      );
    }

    const fallbackIds = fallbacks.map((fallback) =>
      typeof fallback.model === "string" ? normalizeModelId(fallback.model) : ""
    );
    if (
      fallbackIds.some((fallbackId) => !fallbackId || fallbackId === normalizeModelId(modelId)) ||
      new Set(fallbackIds).size !== fallbackIds.length
    ) {
      throw new ValidationError(
        'Provider "anthropic" requires fallback models to be non-empty, unique, and different from the primary model.'
      );
    }

    if (fallbacks.some((fallback) => fallback.max_tokens !== undefined && (!Number.isInteger(fallback.max_tokens) || fallback.max_tokens <= 0))) {
      throw new ValidationError(
        'Provider "anthropic" requires fallback "max_tokens" values to be positive integers.'
      );
    }
  }

  if (midConversationToolChanges && !isClaudeOpus5Model(modelId)) {
    throw new UnsupportedFeatureError(
      'Provider "anthropic" only supports mid-conversation tool changes for Claude Opus 5.'
    );
  }

  if (
    betas.some(
      (beta) =>
        typeof beta !== "string" ||
        !/^[a-z0-9][a-z0-9-]*$/.test(beta)
    )
  ) {
    throw new ValidationError(
      'Provider "anthropic" beta feature names must contain only lowercase letters, numbers, and hyphens.'
    );
  }
};

interface PreparedAnthropicRequest {
  providerOptions: AnthropicLanguageModelOptions;
  thinking?: AnthropicThinkingConfig;
  outputConfig?: AnthropicOutputConfig;
  extraBetas: string[];
}

const prepareAnthropicRequest = (
  modelId: string,
  input: ModelGenerateInput
): PreparedAnthropicRequest => {
  const providerOptions = { ...(input.providerOptions ?? {}) } as AnthropicLanguageModelOptions;
  const rawThinking = providerOptions.thinking;
  const rawOutputConfig = providerOptions.output_config;
  if (providerOptions.betas !== undefined && !Array.isArray(providerOptions.betas)) {
    throw new ValidationError('Provider "anthropic" requires "betas" to be an array of beta feature names.');
  }
  const betas = providerOptions.betas ?? [];
  const midConversationToolChanges = providerOptions.midConversationToolChanges === true;
  delete providerOptions.thinking;
  delete providerOptions.output_config;
  delete providerOptions.betas;
  delete providerOptions.midConversationToolChanges;

  const reasoning = mapReasoning(modelId, input);
  const thinking =
    input.reasoning?.effort === "none"
      ? mergeThinkingConfig(rawThinking, reasoning?.thinking)
      : mergeThinkingConfig(reasoning?.thinking, rawThinking);
  const outputConfig = mergeOptionalObjects(
    mergeOptionalObjects(rawOutputConfig, reasoning?.output_config),
    input.structuredOutput?.mode === "native"
      ? {
          format: {
            type: "json_schema",
            schema: toJSONSchema(input.structuredOutput.schema)
          }
        }
      : undefined
  );

  assertAnthropicRequestCompatibility(
    modelId,
    input,
    thinking,
    outputConfig,
    providerOptions,
    betas,
    midConversationToolChanges
  );

  const extraBetas = [
    ...betas,
    ...(providerOptions.speed === "fast" ? [FAST_MODE_BETA] : []),
    ...(outputConfig?.task_budget ? [TASK_BUDGETS_BETA] : []),
    ...(providerOptions.fallbacks === "default"
      ? [SERVER_SIDE_FALLBACK_DEFAULT_BETA]
      : Array.isArray(providerOptions.fallbacks)
        ? [SERVER_SIDE_FALLBACK_LIST_BETA]
        : []),
    ...(midConversationToolChanges ? [MID_CONVERSATION_TOOL_CHANGES_BETA] : [])
  ];

  return {
    providerOptions,
    thinking,
    outputConfig,
    extraBetas
  };
};

class AnthropicLanguageModel implements LanguageModel<AnthropicLanguageModelOptions> {
  readonly provider = "anthropic";
  readonly capabilities: ModelCapabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly anthropicVersion: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {
    this.capabilities = modelCapabilities(modelId);
  }

  private headers(withMcpToolset: boolean, withFilesApi: boolean, extraBetas: string[] = []) {
    const betas = new Set([
      ...(withMcpToolset ? ["mcp-client-2025-11-20"] : []),
      ...(withFilesApi ? ["files-api-2025-04-14"] : []),
      ...extraBetas
    ]);

    return {
      "content-type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": this.anthropicVersion,
      ...(betas.size ? { "anthropic-beta": Array.from(betas).join(",") } : {})
    };
  }

  async generate(input: ModelGenerateInput): Promise<GenerateResult> {
    const { signal, cleanup } = withTimeoutSignal(input);
    const mcpServers = mapMcpServers(input.tools);
    const { providerOptions, thinking, outputConfig, extraBetas } = prepareAnthropicRequest(this.modelId, input);
    const usesFilesApi = input.messages.some((message) =>
      message.parts.some((part) => part.type === "file" && isAnthropicFileId(part.data))
    );

    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/messages`, {
            method: "POST",
            headers: this.headers(Boolean(mcpServers?.length), usesFilesApi, extraBetas),
            signal,
            body: JSON.stringify({
              ...providerOptions,
              model: this.modelId,
              system: systemPromptFromMessages(this.modelId, input.messages),
              messages: mapMessages(this.modelId, input.messages),
              ...(mcpServers ? { mcp_servers: mcpServers } : {}),
              tools: mapTools(input.tools),
              tool_choice: mapToolChoice(input.toolChoice),
              temperature: input.temperature,
              max_tokens: input.maxTokens ?? 1024,
              ...(outputConfig ? { output_config: outputConfig } : {}),
              ...(thinking ? { thinking } : {})
            })
          }),
        input
      );

      const json = await parseJson(response);
      const assistantMessage = parseAssistantMessage(json);

      return {
        messages: [assistantMessage],
        text: assistantMessage.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
        finishReason: normalizeFinishReason(json.stop_reason),
        providerFinishReason: json.stop_reason,
        usage: mapAnthropicUsage(json.usage),
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }

  async stream(input: ModelGenerateInput): Promise<AsyncIterable<StreamEvent>> {
    const { signal, cleanup } = withTimeoutSignal(input);
    const mcpServers = mapMcpServers(input.tools);
    const { providerOptions, thinking, outputConfig, extraBetas } = prepareAnthropicRequest(this.modelId, input);
    const usesFilesApi = input.messages.some((message) =>
      message.parts.some((part) => part.type === "file" && isAnthropicFileId(part.data))
    );
    const response = await withRetry(
      () =>
        this.fetcher(`${this.baseURL}/messages`, {
          method: "POST",
          headers: this.headers(Boolean(mcpServers?.length), usesFilesApi, extraBetas),
          signal,
          body: JSON.stringify({
            ...providerOptions,
            model: this.modelId,
            system: systemPromptFromMessages(this.modelId, input.messages),
            messages: mapMessages(this.modelId, input.messages),
            ...(mcpServers ? { mcp_servers: mcpServers } : {}),
            tools: mapTools(input.tools),
            tool_choice: mapToolChoice(input.toolChoice),
            temperature: input.temperature,
            max_tokens: input.maxTokens ?? 1024,
            stream: true,
            ...(outputConfig ? { output_config: outputConfig } : {}),
            ...(thinking ? { thinking } : {})
          })
        }),
      input
    );

    return (async function* () {
      try {
        const toolBuffers = new Map<number, { id: string; name: string; input: string }>();
        let stopReason: string | undefined;
        let usage: GenerateResult["usage"];

        for await (const event of streamSSE(response)) {
          const json = JSON.parse(event.data);

          if (event.event === "message_start") {
            const nextUsage = mapAnthropicUsage(json.message?.usage ?? json.usage);
            if (nextUsage) {
              usage = mergeAnthropicUsage(usage, nextUsage);
            }
          }
          if (event.event === "content_block_delta" && json.delta?.type === "text_delta") {
            yield { type: "text-delta", textDelta: json.delta.text } satisfies StreamEvent;
          }

          if (event.event === "content_block_start" && json.content_block?.type === "tool_use") {
            toolBuffers.set(json.index, {
              id: json.content_block.id,
              name: json.content_block.name,
              input: ""
            });
          }

          if (
            event.event === "content_block_start" &&
            typeof json.content_block?.type === "string" &&
            json.content_block.type !== "text" &&
            json.content_block.type !== "tool_use"
          ) {
            yield {
              type: "provider-data",
              provider: "anthropic",
              data: json.content_block as JsonValue
            } satisfies StreamEvent;
          }

          if (
            event.event === "content_block_delta" &&
            typeof json.delta?.type === "string" &&
            json.delta.type !== "text_delta" &&
            json.delta.type !== "input_json_delta"
          ) {
            yield {
              type: "provider-data",
              provider: "anthropic",
              data: json.delta as JsonValue
            } satisfies StreamEvent;
          }

          if (event.event === "content_block_delta" && json.delta?.type === "input_json_delta") {
            const current = toolBuffers.get(json.index);
            if (current) {
              current.input += json.delta.partial_json;
            }
          }

          if (event.event === "message_delta") {
            stopReason = json.delta?.stop_reason ?? stopReason;
            const nextUsage = mapAnthropicUsage(json.usage);
            if (nextUsage) {
              usage = mergeAnthropicUsage(usage, nextUsage);
            }

            if (json.delta?.stop_details) {
              yield {
                type: "provider-data",
                provider: "anthropic",
                data: {
                  type: "stop_details",
                  stop_details: json.delta.stop_details
                } as JsonValue
              } satisfies StreamEvent;
            }
          }

          if (event.event === "content_block_stop") {
            const current = toolBuffers.get(json.index);
            if (current) {
              yield {
                type: "tool-call",
                toolCall: {
                  id: current.id,
                  name: current.name,
                  input: JSON.parse(current.input || "{}")
                }
              } satisfies StreamEvent;
            }
          }

          if (event.event === "message_stop") {
            const providerFinishReason = stopReason ?? json.stop_reason;
            yield {
              type: "finish",
              finishReason: normalizeFinishReason(providerFinishReason),
              providerFinishReason,
              ...(usage ? { usage } : {})
            } satisfies StreamEvent;
          }
        }
      } finally {
        cleanup();
      }
    })();
  }
}

export const createAnthropic = (
  options: AnthropicProviderOptions = {}
): CallableProviderAdapter & ProviderAdapter & { rawFetch: typeof globalThis.fetch } => {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ConfigurationError("Missing Anthropic API key.");
  }

  const baseURL = options.baseURL ?? "https://api.anthropic.com/v1";
  const anthropicVersion = options.anthropicVersion ?? "2023-06-01";
  const fetcher = options.fetch ?? globalThis.fetch;

  return createProviderAdapter({
    name: "anthropic",
    languageModel: (modelId) => new AnthropicLanguageModel(modelId, apiKey, baseURL, anthropicVersion, fetcher),
    rawFetch: fetcher
  });
};

export interface AnthropicWebSearchToolConfig {
  type?: "web_search_20260209" | "web_search_20250305";
  max_uses?: number;
  allowed_domains?: string[];
  blocked_domains?: string[];
  user_location?: {
    type: "approximate";
    city?: string;
    region?: string;
    country?: string;
    timezone?: string;
  };
}

export interface AnthropicCodeExecutionToolConfig {
  name?: string;
  type?: "code_execution_20250825" | "code_execution_20260120" | "code_execution_20260521";
}

export interface AnthropicMcpServerConfig {
  type?: "url";
  url: string;
  name: string;
  authorization_token?: string;
}

export interface AnthropicMcpToolConfig {
  enabled?: boolean;
  defer_loading?: boolean;
}

export interface AnthropicMcpToolsetConfig {
  server: AnthropicMcpServerConfig;
  default_config?: AnthropicMcpToolConfig;
  configs?: Record<string, AnthropicMcpToolConfig>;
  cache_control?: Record<string, unknown>;
}

export interface AnthropicMcpToolUseBlock {
  type: "mcp_tool_use";
  id: string;
  name: string;
  server_name: string;
  input: JsonValue;
}

export interface AnthropicMcpToolResultBlock {
  type: "mcp_tool_result";
  tool_use_id: string;
  is_error?: boolean;
  content: JsonValue;
  server_name?: string;
}

export const anthropicWebSearchTool = (config: AnthropicWebSearchToolConfig = {}) =>
  hostedTool({
    name: "web_search",
    provider: "anthropic",
    type: config.type ?? "web_search_20260209",
    toolClass: "web-search",
    config: Object.fromEntries(Object.entries(config).filter(([key]) => key !== "type")) as unknown as JsonValue
  });

export const anthropicCodeExecutionTool = (config: AnthropicCodeExecutionToolConfig = {}) =>
  hostedTool({
    name: config.name ?? "code_execution",
    provider: "anthropic",
    type: config.type ?? "code_execution_20260521",
    toolClass: "code-execution",
    config: {} as JsonValue
  });

export const anthropicMcpToolset = (config: AnthropicMcpToolsetConfig) =>
  hostedTool({
    name: config.server.name,
    provider: "anthropic",
    type: "mcp_toolset",
    toolClass: "toolset",
    config: config as unknown as JsonValue
  });
