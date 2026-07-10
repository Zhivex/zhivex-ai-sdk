# @zhivex-ai/openai

OpenAI adapter for Zhivex AI SDK.

## Install

```bash
bun add @zhivex-ai/openai @zhivex-ai/core zod
```

## Audio response limits

Transcription and speech responses are bounded before JSON parsing or binary buffering. Defaults are 16 MiB for speech, 4 MiB for transcription JSON, and 64 KiB for error bodies. Override them at provider creation time when your application requires a stricter policy:

```ts
const openai = createOpenAI({
  responseLimits: {
    speechBytes: 16 * 1024 * 1024,
    transcriptionBytes: 1024 * 1024,
    errorBodyBytes: 64 * 1024
  }
});
```

Oversized successful bodies throw `ProviderResponseTooLargeError`. Provider HTTP errors keep their original status and expose only a bounded, possibly truncated `responseBody`.

## GPT-5.6

The adapter recognizes the three GPT-5.6 model IDs and their shared SDK surface:

- `gpt-5.6-sol`, also available through the `gpt-5.6` alias
- `gpt-5.6-terra`
- `gpt-5.6-luna`

Upstream availability is currently a limited preview for approved organizations; there is no public enrollment or general-availability date. API and Codex access are approved separately. See [OpenAI's GPT-5.6 preview access notes](https://help.openai.com/en/articles/20001325-a-preview-of-gpt-5-6-sol-terra-and-luna).

GPT-5.6 uses the Responses API by default in this adapter. `providerOptions.apiMode` can force either endpoint for compatibility; `"chat"` cannot be combined with Responses-only tools or Multi-agent.

For prompts with more than 272K input tokens, OpenAI charges 2x the input rate and 1.5x the output rate for the entire request, across Sol, Terra, and Luna. See the official [Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol), [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), and [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) model pages.

```ts
import { generateText } from "@zhivex-ai/core";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

const result = await generateText({
  model: openai("gpt-5.6"),
  prompt: "Design a resilient job queue.",
  reasoning: {
    effort: "max",
    mode: "pro",
    context: "all_turns"
  },
  providerOptions: {
    apiMode: "responses",
    safety_identifier: "user_8f2a"
  }
});

console.log(result.text);
```

`reasoning.mode` (`"standard"` or `"pro"`) and `reasoning.context` (`"auto"`, `"current_turn"`, or `"all_turns"`) are Responses-only controls. Chat Completions continues to accept `reasoning.effort`, including `"max"`, but rejects `mode` and `context` instead of silently dropping them.

Multi-turn Responses normally continue through `previous_response_id`. With `providerOptions.store: false`, the adapter automatically requests `reasoning.encrypted_content` and replays the returned reasoning and output items instead, including across local tool-loop continuations.

Use `providerOptions.safety_identifier` for a stable, non-PII identifier for the end user. It is sent as an OpenAI request field; do not put email addresses, names, or other direct personal data in it.

## Prompt caching

OpenAI prompt cache controls pass through `providerOptions`. Explicit breakpoints can be attached directly to a cacheable text, image, or file part through `providerMetadata`, or inserted immediately after a cacheable part with `openAIPromptCacheBreakpoint()`.

```ts
import { generateText, user } from "@zhivex-ai/core";
import { createOpenAI, openAIPromptCacheBreakpoint } from "@zhivex-ai/openai";

const openai = createOpenAI();

await generateText({
  model: openai("gpt-5.6-terra"),
  messages: [
    user([
      {
        type: "text",
        text: "Reusable project context",
        providerMetadata: {
          openai: { prompt_cache_breakpoint: { mode: "explicit" } }
        }
      },
      { type: "text", text: "Answer the current question." },
      openAIPromptCacheBreakpoint()
    ])
  ],
  providerOptions: {
    prompt_cache_key: "project-docs-v1",
    prompt_cache_options: { mode: "explicit", ttl: "30m" }
  }
});
```

The helper marks the content block immediately before it. Placing it before any cacheable content throws `ConfigurationError`. `prompt_cache_retention` remains available for older model families, but it is a legacy alternative to `prompt_cache_options` and should not be combined with it for GPT-5.6.

For GPT-5.6, cache writes cost 1.25x the uncached input rate and cache reads receive a 90% discount. Normalized usage exposes these as `result.usage.cacheWriteTokens` and `result.usage.cachedInputTokens`; the raw response remains available when provider-specific details are needed. See [OpenAI's pricing and prompt caching notes](https://help.openai.com/en/articles/20001325-a-preview-of-gpt-5-6-sol-terra-and-luna).

## Programmatic Tool Calling

GPT-5.6 supports Programmatic Tool Calling through `openAIProgrammaticToolCallingTool()`. Wrap callable tools with `openAIProgrammaticTool()` to declare `allowed_callers` and an optional provider output schema. The adapter preserves the provider `caller` metadata across tool execution and continuation requests.

```ts
import { generateText, tool } from "@zhivex-ai/core";
import {
  createOpenAI,
  openAIProgrammaticTool,
  openAIProgrammaticToolCallingTool
} from "@zhivex-ai/openai";
import { z } from "zod";

const openai = createOpenAI();
const inventory = openAIProgrammaticTool(
  tool({
    name: "inventory",
    schema: z.object({ sku: z.string() }),
    execute: ({ sku }) => ({ sku, available: 12 })
  }),
  {
    allowedCallers: ["programmatic"],
    outputSchema: z.object({ sku: z.string(), available: z.number() })
  }
);

await generateText({
  model: openai("gpt-5.6-luna"),
  prompt: "Check the requested SKUs efficiently.",
  maxSteps: 4,
  tools: {
    program: openAIProgrammaticToolCallingTool(),
    inventory
  }
});
```

Hosted Code Interpreter and remote MCP accept `allowed_callers`; `openAIHostedShellTool()`, `openAIShellTool()`, and `openAIApplyPatchTool()` expose the equivalent `allowedCallers` option.

## Multi-agent beta

Enable the GPT-5.6 Multi-agent beta with `providerOptions.multi_agent`. The adapter adds the `responses_multi_agent=v1` beta header automatically and returns the root agent's final answer from provider output.

```ts
const result = await generateText({
  model: openai("gpt-5.6-sol"),
  prompt: "Delegate research and implementation planning, then return one final plan.",
  providerOptions: {
    multi_agent: {
      enabled: true,
      max_concurrent_subagents: 3
    }
  }
});
```

## Agent tools and capabilities

GPT-5.6 supports Tool Search, Computer Use GA, hosted and local shell, apply patch, and skills. The adapter validates model/tool combinations before a request is sent. `openAIComputerTool()` exposes GA Computer Use with batched actions and app-owned screenshot execution; `openAIComputerUseTool()` remains available for the legacy preview shape. `openAIShellTool()` and `openAIApplyPatchTool()` are SDK-managed harnesses that require approval by default.

Current family gates are:

| Capability | Supported OpenAI model families |
| --- | --- |
| Tool Search | GPT-5.6; GPT-5.5 base; GPT-5.4 base and mini |
| Computer Use | GPT-5.6; GPT-5.5 base; GPT-5.4 base and mini |
| Shell | GPT-5.6; GPT-5.5 base and pro; GPT-5.4 base, mini, nano, and pro |
| Apply patch and skills | GPT-5.6; GPT-5.5 base; GPT-5.4 base, mini, and nano |
| Programmatic Tool Calling and Multi-agent | GPT-5.6 |

```ts
import { getAgentCapabilities } from "@zhivex-ai/core";
import {
  openAIComputerTool,
  openAIShellTool,
  openAIToolSearchTool
} from "@zhivex-ai/openai";

const model = openai("gpt-5.6-sol");
console.log(getAgentCapabilities(model));

declare const computerHarness: {
  execute(actions: unknown[]): Promise<void>;
  screenshot(): Promise<string>;
};

await generateText({
  model,
  prompt: "Inspect the project and the current browser state.",
  maxSteps: 4,
  toolApprovalPolicy: () => ({ approved: true }),
  tools: {
    search: openAIToolSearchTool(),
    computer: openAIComputerTool({
      async execute({ actions }) {
        await computerHarness.execute(actions);
        return {
          type: "computer_screenshot",
          image_url: await computerHarness.screenshot()
        };
      }
    }),
    shell: openAIShellTool({
      rootDir: process.cwd(),
      timeoutMs: 10_000,
      environment: {
        type: "local",
        skills: [
          {
            name: "repo-conventions",
            description: "Repository-specific implementation rules",
            path: ".agents/skills/repo-conventions"
          }
        ]
      }
    })
  }
});
```

Local and hosted shell are deliberately separate:

- `openAIShellTool()` runs commands through an app-owned local callback or process and accepts only `environment.type: "local"`.
- `openAIHostedShellTool()` sends `container_auto` or `container_reference` to OpenAI. It never re-executes hosted commands in the local process.

Hosted containers have no outbound network access by default. Enabling it requires both an organization allowlist and a request-level `network_policy`. The request may only narrow the organization policy:

```ts
import { openAIHostedShellTool } from "@zhivex-ai/openai";

const hostedShell = openAIHostedShellTool({
  allowedCallers: ["direct", "programmatic"],
  environment: {
    type: "container_auto",
    skills: [
      { type: "skill_reference", skill_id: "skill_123", version: "latest" }
    ],
    network_policy: {
      type: "allowlist",
      allowed_domains: ["api.example.com"],
      domain_secrets: [
        {
          domain: "api.example.com",
          name: "API_TOKEN",
          value: process.env.EXAMPLE_API_TOKEN!
        }
      ]
    }
  }
});
```

Treat every allowlisted domain as an exfiltration boundary. Prompt injection can cause a shell workflow to send data or injected domain secrets outward, so allow only domains you trust and that an attacker cannot use as a data receiver. See OpenAI's [Hosted Shell network and safety guidance](https://developers.openai.com/api/docs/guides/tools-shell#network-access).

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
