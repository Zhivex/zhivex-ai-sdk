import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createProviderSupportDriftReport,
  createProviderSupportMatrix,
  renderProviderSupportMatrix,
  type ProviderSupportDriftExpectedMatrix,
  type ProviderSupportMatrixEntry
} from "../src/index.js";
import { createAnthropic } from "../../anthropic/src/index.js";
import { createAzureOpenAI } from "../../azure-openai/src/index.js";
import { createBedrock } from "../../bedrock/src/index.js";
import { createDeepSeek } from "../../deepseek/src/index.js";
import { createZAI } from "../../zai/src/index.js";
import { createGemini } from "../../gemini/src/index.js";
import { createKimi } from "../../kimi/src/index.js";
import { createMeta } from "../../meta/src/index.js";
import { createOllama } from "../../ollama/src/index.js";
import { createOpenAI } from "../../openai/src/index.js";
import { createOpenRouter } from "../../openrouter/src/index.js";
import { createQwen } from "../../qwen/src/index.js";
import { createVertex } from "../../vertex/src/index.js";
import { createXAI } from "../../xai/src/index.js";

const README_PATH = path.resolve(import.meta.dirname, "../../../docs/reference/PROVIDERS.md");
const MATRIX_START = "<!-- provider-matrix:start -->";
const MATRIX_END = "<!-- provider-matrix:end -->";

const normalizeMarkdownTable = (table: string) =>
  table
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

const extractReadmeProviderMatrix = async () => {
  const readme = await readFile(README_PATH, "utf8");
  const start = readme.indexOf(MATRIX_START);
  const end = readme.indexOf(MATRIX_END);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Provider compatibility matrix markers are missing or out of order in docs/reference/PROVIDERS.md.");
  }

  return normalizeMarkdownTable(readme.slice(start + MATRIX_START.length, end));
};

const fetchMock = vi.fn();
const openai = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
const xai = createXAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
const meta = createMeta({ apiKey: "test", fetch: fetchMock as typeof fetch });
const azure = createAzureOpenAI({
  apiKey: "test",
  endpoint: "https://example.openai.azure.com",
  fetch: fetchMock as typeof fetch
});
const anthropic = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
const gemini = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
const vertex = createVertex({ apiKey: "test", projectId: "test", location: "us-central1", fetch: fetchMock as typeof fetch });
const openrouter = createOpenRouter({ apiKey: "test", fetch: fetchMock as typeof fetch });
const qwen = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
const kimi = createKimi({ apiKey: "test", fetch: fetchMock as typeof fetch });
const deepseek = createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch });
const zai = createZAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
const bedrockConverse = createBedrock({ region: "us-east-1" });
const bedrockOpenAI = createBedrock({
  runtime: "openai",
  baseURL: "https://bedrock-mantle.us-east-1.amazonaws.com/openai/v1",
  apiKey: "test",
  fetch: fetchMock as typeof fetch
});
const ollama = createOllama({ fetch: fetchMock as typeof fetch });

const matrixEntries: ProviderSupportMatrixEntry[] = [
  {
    provider: "OpenAI",
    model: openai("gpt-4o-mini"),
    summary: {
      reasoningSummary: "`effort`",
      hostedToolSummary: "model-dependent Responses hosted tools including image generation, remote MCP, shell/apply patch harness",
      liveCertified: "not recorded"
    }
  },
  {
    provider: "xAI",
    model: xai("grok-4.5"),
    summary: {
      reasoningSummary: "Grok 4.7 / 4.6 / 4.5 `low` / `medium` / `high` / `xhigh`",
      hostedToolSummary: "Responses Web Search, X Search, code execution, Collections search, Files API, prompt caching",
      liveCertified: "not recorded"
    }
  },
  {
    provider: "Meta",
    model: meta("muse-spark-1.2"),
    summary: {
      reasoningSummary: "`effort`",
      hostedToolSummary: "Responses web search, tool search, Files API, prompt caching",
      liveCertified: "not certified"
    }
  },
  {
    provider: "Azure OpenAI",
    model: azure("gpt-4o-mini"),
    summary: {
      reasoningSummary: "`effort`",
      hostedToolSummary: "model-dependent Responses hosted tools, remote MCP, shell/apply patch harness",
      liveCertified: "not recorded"
    }
  },
  {
    provider: "Anthropic",
    model: anthropic("claude-opus-5"),
    summary: {
      structuredOutputSummary: "native",
      reasoningSummary: "Opus 5 `low` / `medium` / `high` / `xhigh` / `max`",
      hostedToolSummary: "native MCP, web search, code execution",
      liveCertified: "not recorded"
    }
  },
  {
    provider: "Gemini",
    model: gemini("gemini-3.5-flash"),
    summary: {
      structuredOutputSummary: "native",
      reasoningSummary: "model-dependent",
      hostedToolSummary: "native",
      liveCertified: "2026-08-05 pass; 2026-09-19 not certified"
    }
  },
  {
    provider: "Vertex",
    model: vertex("gemini-3.5-flash"),
    summary: {
      structuredOutputSummary: "native",
      reasoningSummary: "model-dependent",
      hostedToolSummary: "native",
      liveCertified: "2026-09-19 local pass; not release-certified"
    }
  },
  {
    provider: "OpenRouter",
    model: openrouter("openai/gpt-4o-mini"),
    summary: {
      structuredOutputSummary: "native",
      reasoningSummary: "`effort` + `budgetTokens`",
      hostedToolSummary: "server tools",
      liveCertified: "not recorded"
    }
  },
  {
    provider: "Qwen",
    model: qwen("qwen-plus"),
    summary: {
      structuredOutputSummary: "JSON object + schema prompt",
      reasoningSummary: "Responses effort / Chat budget",
      hostedToolSummary: "Responses hosted tools; Cloud files, batch, multimodal embeddings, rerank, ASR, TTS, image, video, realtime",
      agentTierLabel: "Tier B text Responses / Tier A Omni 3.8 realtime",
      liveCertified: "2026-08-05 pass; 2026-09-19 source pass"
    }
  },
  {
    provider: "Kimi",
    model: kimi("kimi-k3"),
    summary: {
      structuredOutputSummary: "native",
      reasoningSummary: "K3 `max`; K2.x model-dependent",
      hostedToolSummary: "Formula tools via Chat Completions",
      liveCertified: "not recorded"
    }
  },
  {
    provider: "DeepSeek",
    model: deepseek("deepseek-v4-flash"),
    summary: {
      structuredOutputSummary: "JSON object",
      reasoningSummary: "`none` / `high` / `max`",
      hostedToolSummary: "no",
      liveCertified: "2026-08-05 pass; 2026-09-19 streaming not certified"
    }
  },
  {
    provider: "Z.ai",
    model: zai("glm-5.3"),
    summary: {
      structuredOutputSummary: "JSON object + schema prompt",
      reasoningSummary: "5.3/5.3 Flash `low` / `high` / `max`; 5.2 mapped",
      hostedToolSummary: "no",
      liveCertified: "not recorded"
    }
  },
  {
    provider: "Bedrock",
    model: bedrockConverse("anthropic.claude-3-5-sonnet"),
    summary: {
      hostedToolSummary: "Converse baseline or Mantle/OpenAI-compatible Responses hosted tools and remote MCP",
      reasoningSummary: "endpoint-dependent",
      agentTierLabel: "Tier B Converse / Tier A OpenAI-compatible",
      liveCertified: "not recorded",
      notes: "README row combines Bedrock Converse and Bedrock OpenAI-compatible runtime.",
      // README documents Bedrock's two runtime modes in one row.
      // Converse is Tier B while the OpenAI-compatible runtime is Tier A.
      structuredOutputSummary: "native"
    }
  },
  {
    provider: "Ollama",
    model: ollama("llama3.2"),
    summary: {
      structuredOutputSummary: "native",
      hostedToolSummary: "no",
      reasoningSummary: "model-dependent",
      liveCertified: "not recorded"
    }
  }
];

const expectedDrift: ProviderSupportDriftExpectedMatrix = {
  entries: [
    { provider: "openai", agentTier: "tier-a", approvalReady: true, remoteMcp: true },
    { provider: "xai", agentTier: "tier-b", hostedTools: true, codeExecution: true, webSearch: true },
    { provider: "meta", agentTier: "tier-b", hostedTools: true, webSearch: true },
    { provider: "azure-openai", agentTier: "tier-a", approvalReady: true, remoteMcp: true },
    { provider: "anthropic", agentTier: "tier-b", hostedTools: true, codeExecution: true, webSearch: true },
    { provider: "gemini", agentTier: "tier-b", structuredOutput: true, embeddings: true, webSearch: true },
    { provider: "vertex", agentTier: "tier-b", structuredOutput: true, embeddings: true, webSearch: true },
    { provider: "qwen", agentTier: "tier-b", portableToolLoop: true, webSearch: true },
    { provider: "deepseek", agentTier: "tier-b", portableToolLoop: true, webSearch: false },
    { provider: "zai", agentTier: "tier-b", portableToolLoop: true, toolChoice: false, webSearch: false },
    { provider: "openrouter", agentTier: "tier-c", portableToolLoop: true, hostedTools: true },
    { provider: "kimi", agentTier: "tier-c", portableToolLoop: true, embeddings: false },
    { provider: "ollama", agentTier: "tier-c", toolChoice: false, embeddings: true },
    { provider: "bedrock", modelId: "anthropic.claude-3-5-sonnet", agentTier: "tier-b" },
    { provider: "bedrock", modelId: "openai.gpt-oss-120b-1:0", agentTier: "tier-a", remoteMcp: true }
  ]
};

describe("provider parity documentation", () => {
  it("keeps the provider compatibility matrix aligned with runtime provider metadata", async () => {
    const rendered = [
      [
        "| OpenAI | yes | yes | yes | native | yes | no | no | no | no | `effort` | yes | model-dependent Responses hosted tools including image generation, remote MCP, shell/apply patch harness | Tier A | not recorded |",
        "| OpenAI | yes | yes | yes | native | yes | yes | yes | yes | yes | model-dependent; GPT-5.6 `max` / `pro` / context | yes | model-dependent Responses hosted tools including image generation, remote MCP, shell/apply patch harness | Tier A | not recorded |"
      ],
      [
        "| Azure OpenAI | yes | yes | yes | native | yes | no | no | no | no | `effort` | yes | model-dependent Responses hosted tools, remote MCP, shell/apply patch harness | Tier A | not recorded |",
        "| Azure OpenAI | yes | yes | yes | native | yes | yes | yes | yes | yes | `effort` | yes | model-dependent Responses hosted tools, remote MCP, shell/apply patch harness | Tier A | not recorded |"
      ],
      [
        "| Gemini | yes | yes | yes | native | yes | yes | no | no | no | model-dependent | yes | native | Tier B | 2026-08-05 pass; 2026-09-19 not certified |",
        "| Gemini | yes | yes | yes | native | yes | yes | yes | yes | yes | model-dependent | yes | native | Tier B | 2026-08-05 pass; 2026-09-19 not certified |"
      ],
      [
        "| Vertex | yes | yes | yes | native | yes | yes | no | no | no | model-dependent | yes | native | Tier B | 2026-09-19 local pass; not release-certified |",
        "| Vertex | yes | yes | yes | native | yes | yes | yes | yes | no | model-dependent | yes | native | Tier B | 2026-09-19 local pass; not release-certified |"
      ],
      [
        "| Qwen | yes | yes | yes | JSON object + schema prompt | yes | no | no | no | no | Responses effort / Chat budget | yes | Responses hosted tools; Cloud files, batch, multimodal embeddings, rerank, ASR, TTS, image, video, realtime | Tier B text Responses / Tier A Omni 3.8 realtime | 2026-08-05 pass; 2026-09-19 source pass |",
        "| Qwen | yes | yes | yes | JSON object + schema prompt | yes | model-dependent | yes | yes | no | Responses effort / Chat budget | yes | Responses hosted tools; Cloud files, batch, multimodal embeddings, rerank, ASR, TTS, image, video, realtime | Tier B text Responses / Tier A Omni 3.8 realtime | 2026-08-05 pass; 2026-09-19 source pass |"
      ],
      [
        "| Kimi | yes | yes | yes | native | no | no | no | no | no | K3 `max`; K2.x model-dependent | no | Formula tools via Chat Completions | Tier C | not recorded |",
        "| Kimi | yes | yes | yes | native | no | no | no | no | no | K3 `max`; K2.x model-dependent | Formula tool | Formula tools via Chat Completions | Tier C | not recorded |"
      ],
      [
        "| Bedrock | yes | yes | yes | native | no | no | no | no | no | endpoint-dependent | no | Converse baseline or Mantle/OpenAI-compatible Responses hosted tools and remote MCP | Tier B Converse / Tier A OpenAI-compatible | not recorded |",
        "| Bedrock | yes | yes | endpoint-dependent | native | no | no | no | no | no | endpoint-dependent | endpoint-dependent | Converse baseline or Mantle/OpenAI-compatible Responses hosted tools and remote MCP | Tier B Converse / Tier A OpenAI-compatible | not recorded |"
      ]
    ].reduce(
      (table, [from, to]) => table.replace(from, to),
      renderProviderSupportMatrix(createProviderSupportMatrix(matrixEntries))
    );

    expect(normalizeMarkdownTable(rendered)).toBe(await extractReadmeProviderMatrix());
  });

  it("keeps high-value provider tier and capability expectations drift-free", () => {
    const matrix = createProviderSupportMatrix([
      openai("gpt-4o-mini"),
      xai("grok-4.5"),
      meta("muse-spark-1.2"),
      azure("gpt-4o-mini"),
      anthropic("claude-opus-5"),
      gemini("gemini-3.5-flash"),
      vertex("gemini-3.5-flash"),
      qwen("qwen-plus"),
      deepseek("deepseek-v4-flash"),
      zai("glm-5.3"),
      openrouter("openai/gpt-4o-mini"),
      kimi("kimi-k3"),
      ollama("llama3.2"),
      bedrockConverse("anthropic.claude-3-5-sonnet"),
      bedrockOpenAI("openai.gpt-oss-120b-1:0")
    ]);

    expect(createProviderSupportDriftReport(matrix, expectedDrift)).toEqual({
      ok: true,
      missing: [],
      unexpected: [],
      changed: []
    });
  });
});
