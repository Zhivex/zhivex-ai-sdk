# Tools recipes

Tool calling, MCP, and the experimental advanced tool registry.

[Documentation index](../README.md)

## Tool Calling

Tools are modeled in the shared contract, and the SDK preserves a multi-step loop through `maxSteps`.

```ts
import { generateText, tool, user } from "@zhivex-ai/sdk";
import { createAnthropic } from "@zhivex-ai/anthropic";
import { z } from "zod";

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const result = await generateText({
  model: anthropic("claude-opus-5"),
  messages: [user("What is the weather in Madrid?")],
  maxSteps: 2,
  tools: {
    weather: tool({
      name: "weather",
      description: "Get weather by city",
      schema: z.object({
        city: z.string()
      }),
      execute: async ({ city }) => ({
        city,
        forecast: "sunny"
      })
    })
  }
});

console.log(result.text);
console.log(result.toolResults);
```

Provider-hosted tools use the same `tools` registry through `hostedTool`. This lets providers expose native capabilities such as OpenAI/Azure Responses tools or Gemini/Vertex built-ins without breaking the common contract.

OpenRouter server tools are available through the same hosted-tool mechanism:

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createOpenRouter, openRouterWebSearchTool } from "@zhivex-ai/openrouter";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY
});

const result = await generateText({
  model: openrouter("openai/gpt-4o-mini"),
  prompt: "What were the major AI announcements this week?",
  tools: {
    web: openRouterWebSearchTool({
      max_results: 5,
      allowed_domains: ["openai.com", "anthropic.com"]
    })
  }
});

console.log(result.text);
```

OpenAI and Azure OpenAI can expose Responses agent tools through provider helpers. In this OpenAI example, `openAIShellTool()` and `openAIApplyPatchTool()` are SDK-managed local harnesses, so they require an explicit approval policy by default. Provider-executed OpenAI shell uses the separate `openAIHostedShellTool()`. This local example attaches a skill directory to the GPT-5.6 shell environment:

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createOpenAI, openAIApplyPatchTool, openAIShellTool } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = await generateText({
  model: openai("gpt-5.6-sol"),
  prompt: "Inspect package scripts and propose a tiny patch.",
  maxSteps: 4,
  toolApprovalPolicy({ toolCall }) {
    return toolCall.name === "shell" && String(toolCall.input).includes("npm")
      ? { approved: false, reason: "Use bun in this repository." }
      : { approved: true };
  },
  tools: {
    shell: openAIShellTool({
      rootDir: process.cwd(),
      timeoutMs: 10_000,
      environment: {
        type: "local",
        skills: [
          { name: "repo-rules", path: ".agents/skills/repo-rules" }
        ]
      }
    }),
    patch: openAIApplyPatchTool({
      async applyOperation(operation) {
        return {
          operation,
          applied: false,
          message: "Patch review mode; apply it in your own workspace runner."
        };
      }
    })
  }
});

console.log(result.text);
console.log(result.toolResults);
```

Anthropic exposes Claude web search by default with `web_search_20260209` and the current generally
available `code_execution_20260521` tool through a native helper:

```ts
import { generateText } from "@zhivex-ai/sdk";
import { anthropicCodeExecutionTool, anthropicWebSearchTool, createAnthropic } from "@zhivex-ai/anthropic";

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const result = await generateText({
  model: anthropic("claude-opus-5"),
  prompt: "Research this API change and verify the migration with code.",
  tools: {
    web: anthropicWebSearchTool(),
    code: anthropicCodeExecutionTool()
  }
});

console.log(result.text);
```

xAI exposes Grok 4.6 through Responses by default, including Web Search, X Search, code execution, and Collections search:

```ts
import { generateText } from "@zhivex-ai/core";
import {
  createXAI,
  xAICodeExecutionTool,
  xAIWebSearchTool,
  xAIXSearchTool
} from "@zhivex-ai/xai";

const xai = createXAI({ apiKey: process.env.XAI_API_KEY });

const result = await generateText({
  model: xai("grok-4.6"),
  prompt: "Research the latest release and verify the comparison with code.",
  reasoning: { effort: "medium" },
  providerOptions: { conversationId: "release-check" },
  tools: {
    web: xAIWebSearchTool(),
    x: xAIXSearchTool(),
    code: xAICodeExecutionTool()
  }
});
```

`qwen3.8-omni-flash` supports text/image/audio/video input and text-only output over both Chat Completions and Responses, with streaming and non-streaming generation. Audio/video can use Responses alongside hosted `web_search`; other hosted tools and audio output are rejected. Use `AudioPart` for audio and a `video/*` `FilePart` for video, in user messages. Hybrid reasoning and prompted structured output are supported. The SDK catalog records $0.15/M input, $0.47/M output, and $0.016/M implicit-cache input tokens. See the [Qwen Omni guide](../../packages/qwen/README.md#qwen38-omni-flash) for examples and the opt-in live test command.

Qwen automatically selects between DashScope-compatible Responses and Chat Completions. Responses is used for hosted web search, web extraction, code interpreter, file search, remote MCP, image search, OCR file input, and response continuation; Chat is selected for structured output, audio/video input on earlier models, `maxTokens`, `reasoning.budgetTokens`, or `providerOptions.tool_stream`. You can force a compatible path with `providerOptions.apiMode`. Current catalog examples include production `qwen3.8-flash` and `qwen3.8-max` for standard Model Studio multimodal reasoning, the Token Plan-only `qwen3.8-max-preview`, `qwen3.7-plus`, `qwen3.7-max`, and `qwen-image-2.0-pro` for image generation. Production Qwen 3.8 models use a regular Model Studio key and a compatible standard or workspace endpoint, support hybrid reasoning, image/video understanding, parallel tools, and structured output, and keep thinking enabled by default. Flash has a 1M-token context window, native JSON Schema output, and cataloged QwenCloud rates of $0.16/M input, $0.47/M output, and $0.016/M implicit-cache input tokens. Video is represented by a `FilePart` with a `video/*` MIME type and routed to Chat `video_url`; generic document files are rejected for these production models. The preview remains thinking-only and requires a dedicated `sk-sp-` key plus the exported `QWEN_TOKEN_PLAN_BASE_URL`; the adapter rejects pay-as-you-go/workspace endpoints for that preview before fetch. Token Plan terms restrict those credentials to interactive programming and agent tools. The default international endpoint uses `tongyi-embedding-vision-plus` for multimodal embeddings; `qwen3-vl-embedding` requires a Beijing workspace. Text reranking uses the DashScope-native endpoint so both the global international host and workspace-specific hosts work. Authenticated realtime sessions use a Node/Bun WebSocket transport by default.

```ts
import { generateText } from "@zhivex-ai/sdk";
import {
  createQwen,
  qwenCodeInterpreterTool,
  qwenFileSearchTool,
  qwenMcpTool,
  qwenWebExtractorTool,
  qwenWebSearchTool
} from "@zhivex-ai/qwen";

const qwen = createQwen({
  apiKey: process.env.DASHSCOPE_API_KEY,
  workspaceId: process.env.QWEN_WORKSPACE_ID,
  region: "beijing"
});

const result = await generateText({
  model: qwen("qwen3.8-flash"),
  prompt: "Find current docs, extract the relevant page, and check a sample with code.",
  tools: {
    search: qwenWebSearchTool(),
    extract: qwenWebExtractorTool(),
    code: qwenCodeInterpreterTool(),
    files: qwenFileSearchTool({ vector_store_ids: ["store_1"] }),
    maps: qwenMcpTool({
      server_label: "amap-maps",
      server_protocol: "sse",
      server_url: "https://dashscope-intl.aliyuncs.com/api/v1/mcps/amap-maps/sse",
      headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}` }
    })
  }
});

console.log(result.text);
```

## MCP

The SDK now exposes MCP helpers across the providers that support it:

- `@zhivex-ai/core` and `@zhivex-ai/sdk`: `createMcpToolSet()` wraps an MCP client that can `listTools()` and `callTool()` into local callable tools.
- `@zhivex-ai/core` and `@zhivex-ai/sdk`: `createToolRegistry()` and `createMcpToolRegistry()` help compose local tools, MCP-derived tools, and hosted tools into one registry before converting to a `ToolSet`.
- `@zhivex-ai/openai` and `@zhivex-ai/azure-openai`: remote MCP servers map to native Responses API MCP tools, including approval request/response flow.
- `@zhivex-ai/anthropic`: MCP toolsets map to Anthropic `mcp_servers` plus `mcp_toolset`.
- `@zhivex-ai/gemini` and `@zhivex-ai/vertex`: `geminiMcpTools()` and `vertexMcpTools()` re-export the shared MCP wrapper for SDK-managed MCP clients.
- `@zhivex-ai/bedrock`: `createBedrockAgentCoreMcpClient()` and `createBedrockAgentCoreMcpToolSet()` expose AWS-native AgentCore Runtime or Gateway MCP endpoints as SDK-managed callable tools. This is separate from `runtime: "openai"` hosted MCP and approvals.

SDK-managed MCP tools are supervised by default, and server annotations are untrusted by default. `readOnlyHint: true` can reduce supervision only when the application explicitly sets `trustServerToolAnnotations: true`; missing annotations, destructive/open-world hints, or untrusted annotations require approval. MCP tools that require approval use resumable local interrupts by default.

`createMcpToolSet()` follows opaque `nextCursor` values with bounded `maxListPages` and `maxListedTools`, validates declared `outputSchema` against `structuredContent`, forwards tool-call idempotency and abort signals, and enforces separate list/call timeouts. A server `isError` response remains a tool error and is not treated as a successful schema-validated value.

Use the shared helper when you already have an MCP client in-process:

```ts
import { createMcpToolSet, generateText } from "@zhivex-ai/sdk";
import { createGemini } from "@zhivex-ai/gemini";

const gemini = createGemini({
  apiKey: process.env.GEMINI_API_KEY
});

const tools = await createMcpToolSet(myMcpClient, {
  trustServerToolAnnotations: false,
  maxListPages: 20,
  maxListedTools: 2_000,
  listToolsTimeoutMs: 10_000,
  callToolTimeoutMs: 30_000
});

const result = await generateText({
  model: gemini("gemini-3.7-flash"),
  prompt: "Use the MCP tools if needed.",
  tools
});
```

For AWS-native remote tools on Bedrock Converse, point the Bedrock AgentCore MCP client at either a runtime ARN or an explicit AgentCore/Gateway endpoint and pass the resulting toolset into the shared agent loop:

```ts
import { runAgent } from "@zhivex-ai/sdk";
import { createBedrock, createBedrockAgentCoreMcpToolSet } from "@zhivex-ai/bedrock";

const bedrock = createBedrock({
  region: process.env.AWS_REGION
});

const tools = await createBedrockAgentCoreMcpToolSet(
  {
    runtimeArn: process.env.AGENTCORE_RUNTIME_ARN,
    region: process.env.AWS_REGION,
    bearerToken: process.env.AGENTCORE_BEARER_TOKEN
  },
  {
    toolNamePrefix: "agentcore_"
  }
);

const result = await runAgent(
  {
    model: bedrock("anthropic.claude-3-5-sonnet-20240620-v1:0"),
    tools,
    maxSteps: 4
  },
  {
    prompt: "Use the AWS AgentCore tools when useful."
  }
);
```

When you want a richer composition surface, build a registry first and materialize it with `toToolSet()` only at the edge:

```ts
import { createMcpToolRegistry, createToolRegistry, toToolSet, tool } from "@zhivex-ai/sdk";

const localTools = createToolRegistry({
  weather: tool({
    name: "weather",
    schema: z.object({ city: z.string() }),
    execute: async ({ city }) => ({ city, forecast: "sunny" })
  })
});

const mcpTools = await createMcpToolRegistry(myMcpClient, {
  toolNamePrefix: "docs_"
});

const tools = toToolSet(localTools.merge(mcpTools));
```

## Advanced Tool Registry

The experimental advanced registry adds stronger tool metadata, permission labels, audit fields, HTTP-backed tools, fixture helpers, inspection helpers, and local test helpers while still converting back to the stable `ToolSet` contract.

```ts
import {
  createAdvancedToolRegistry,
  createHttpTool,
  createToolPermissionPreset,
  inspectToolRegistry,
  recordToolTestFixture,
  runToolTestFixture,
  tool
} from "@zhivex-ai/sdk";
import { z } from "zod";

const registry = createAdvancedToolRegistry([
  {
    tool: tool({
      name: "weather",
      schema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, forecast: "sunny" })
    }),
    source: "local",
    ...createToolPermissionPreset("read-only")
  },
  createHttpTool({
    name: "crm_update",
    description: "Update CRM notes through an application-owned service.",
    schema: z.object({ customerId: z.string(), note: z.string() }),
    url: "https://api.example.com/tools/crm-update",
    headers: {
      authorization: `Bearer ${process.env.CRM_TOOL_TOKEN}`
    }
  })
]);

const fixture = await recordToolTestFixture(registry, [
  { toolName: "weather", input: { city: "Madrid" } }
]);
const results = await runToolTestFixture(registry, fixture);
const inspection = inspectToolRegistry(registry);

const tools = registry.toToolSet();
```

`toToolSet()` preserves compatibility with `generateText()`, `runAgent()`, `streamAgent()`, and provider adapters. Sensitive permissions such as `write`, `filesystem`, `code-execution`, `shell`, and `external-side-effect`, as well as `high` or `critical` audit risk, mark the materialized tool as `requiresApproval`.

`createHttpTool()` defaults to a 30-second abortable timeout, rejects redirects, limits response bodies to 4 MiB, and forwards the execution idempotency key in the `idempotency-key` header. These defaults can be tightened per tool.

For OpenAI and Azure OpenAI remote MCP servers, use the provider helpers and pass approval responses back as `provider-data` parts:

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createOpenAI, openAIMcpApprovalResponse, openAIRemoteMcpTool } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = await generateText({
  model: openai("gpt-5"),
  prompt: "Search the docs through MCP.",
  tools: {
    docs: openAIRemoteMcpTool({
      server_label: "docs",
      server_url: "https://example.com/mcp"
    })
  }
});

const approval = result.messages
  .at(-1)
  ?.parts.find((part) => part.type === "provider-data" && part.provider === "openai");

if (approval) {
  await generateText({
    model: openai("gpt-5"),
    messages: [
      ...result.messages,
      {
        role: "user",
        parts: [
          openAIMcpApprovalResponse({
            approval_request_id: "mcpr_123",
            approve: true
          })
        ]
      }
    ],
    tools: {
      docs: openAIRemoteMcpTool({
        server_label: "docs",
        server_url: "https://example.com/mcp"
      })
    }
  });
}
```

If you are already on the shared agent runtime, prefer `runAgent()` / `resumeAgent()` for the same flow. That keeps approvals in `state.pendingApprovals` and avoids rebuilding the follow-up message yourself.

```ts
import { generateText, hostedTool, user } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = await generateText({
  model: openai("gpt-5"),
  messages: [user("Summarize today's AI news and cite sources.")],
  tools: {
    web: hostedTool({
      name: "web",
      provider: "openai",
      type: "web_search"
    })
  }
});

console.log(result.text);
```

When the selected model supports tool selection, you can control it through the common `toolChoice` option instead of dropping to provider-specific request fields.

```ts
const forcedToolResult = await generateText({
  model: anthropic("claude-sonnet-5"),
  messages: [user("What is the weather in Madrid?")],
  tools: {
    weather: tool({
      name: "weather",
      schema: z.object({
        city: z.string()
      }),
      execute: async ({ city }) => ({
        city,
        forecast: "sunny"
      })
    })
  },
  toolChoice: {
    type: "tool",
    toolName: "weather"
  }
});
```

