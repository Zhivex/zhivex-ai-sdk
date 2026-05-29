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
import { createGemini } from "../../gemini/src/index.js";
import { createKimi } from "../../kimi/src/index.js";
import { createOllama } from "../../ollama/src/index.js";
import { createOpenAI } from "../../openai/src/index.js";
import { createOpenRouter } from "../../openrouter/src/index.js";
import { createQwen } from "../../qwen/src/index.js";
import { createVertex } from "../../vertex/src/index.js";

const README_PATH = path.resolve(import.meta.dirname, "../../../README.md");
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
    throw new Error("README provider matrix markers are missing or out of order.");
  }

  return normalizeMarkdownTable(readme.slice(start + MATRIX_START.length, end));
};

const fetchMock = vi.fn();
const openai = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
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
      hostedToolSummary: "model-dependent Responses hosted tools, remote MCP, shell/apply patch harness"
    }
  },
  {
    provider: "Azure OpenAI",
    model: azure("gpt-4o-mini"),
    summary: {
      reasoningSummary: "`effort`",
      hostedToolSummary: "model-dependent Responses hosted tools, remote MCP, shell/apply patch harness"
    }
  },
  {
    provider: "Anthropic",
    model: anthropic("claude-3-5-sonnet"),
    summary: {
      structuredOutputSummary: "prompted",
      reasoningSummary: "model-dependent",
      hostedToolSummary: "native MCP, web search, code execution"
    }
  },
  {
    provider: "Gemini",
    model: gemini("gemini-3.5-flash"),
    summary: {
      structuredOutputSummary: "native",
      reasoningSummary: "model-dependent",
      hostedToolSummary: "native"
    }
  },
  {
    provider: "Vertex",
    model: vertex("gemini-3.5-flash"),
    summary: {
      structuredOutputSummary: "native",
      reasoningSummary: "model-dependent",
      hostedToolSummary: "native"
    }
  },
  {
    provider: "OpenRouter",
    model: openrouter("openai/gpt-4o-mini"),
    summary: {
      structuredOutputSummary: "native",
      reasoningSummary: "`effort` + `budgetTokens`",
      hostedToolSummary: "server tools"
    }
  },
  {
    provider: "Qwen",
    model: qwen("qwen-plus"),
    summary: {
      structuredOutputSummary: "native",
      reasoningSummary: "model-dependent",
      hostedToolSummary: "Responses web search, web extractor, code interpreter, file search, remote MCP, image search; Cloud files, batch, media, speech, realtime"
    }
  },
  {
    provider: "Kimi",
    model: kimi("kimi-k2.5"),
    summary: {
      structuredOutputSummary: "native",
      reasoningSummary: "model-dependent",
      hostedToolSummary: "Formula tools via Chat Completions"
    }
  },
  {
    provider: "DeepSeek",
    model: deepseek("deepseek-v4-flash"),
    summary: {
      structuredOutputSummary: "JSON object",
      reasoningSummary: "`effort`",
      hostedToolSummary: "no"
    }
  },
  {
    provider: "Bedrock",
    model: bedrockConverse("anthropic.claude-3-5-sonnet"),
    summary: {
      hostedToolSummary: "Converse baseline or Mantle/OpenAI-compatible Responses hosted tools and remote MCP",
      reasoningSummary: "endpoint-dependent",
      notes: "README row combines Bedrock Converse and Bedrock OpenAI-compatible runtime.",
      // README documents Bedrock's two runtime modes in one row.
      // Converse is Tier C while the OpenAI-compatible runtime is Tier A.
      structuredOutputSummary: "native"
    }
  },
  {
    provider: "Ollama",
    model: ollama("llama3.2"),
    summary: {
      structuredOutputSummary: "native",
      hostedToolSummary: "no",
      reasoningSummary: "no"
    }
  }
];

const expectedDrift: ProviderSupportDriftExpectedMatrix = {
  entries: [
    { provider: "openai", agentTier: "tier-a", approvalReady: true, remoteMcp: true },
    { provider: "azure-openai", agentTier: "tier-a", approvalReady: true, remoteMcp: true },
    { provider: "anthropic", agentTier: "tier-b", hostedTools: true, codeExecution: true, webSearch: true },
    { provider: "gemini", agentTier: "tier-b", structuredOutput: true, embeddings: true, webSearch: true },
    { provider: "vertex", agentTier: "tier-b", structuredOutput: true, embeddings: true, webSearch: true },
    { provider: "qwen", agentTier: "tier-b", portableToolLoop: true, webSearch: true },
    { provider: "deepseek", agentTier: "tier-b", portableToolLoop: true, webSearch: false },
    { provider: "openrouter", agentTier: "tier-c", portableToolLoop: true, hostedTools: true },
    { provider: "kimi", agentTier: "tier-c", portableToolLoop: true, embeddings: false },
    { provider: "ollama", agentTier: "tier-c", toolChoice: false, embeddings: true },
    { provider: "bedrock", modelId: "anthropic.claude-3-5-sonnet", agentTier: "tier-c" },
    { provider: "bedrock", modelId: "openai.gpt-oss-120b-1:0", agentTier: "tier-a", remoteMcp: true }
  ]
};

describe("provider parity documentation", () => {
  it("keeps the README compatibility matrix aligned with runtime provider metadata", async () => {
    const rendered = [
      [
        "| OpenAI | yes | yes | yes | native | yes | no | no | no | no | `effort` | yes | model-dependent Responses hosted tools, remote MCP, shell/apply patch harness | Tier A |",
        "| OpenAI | yes | yes | yes | native | yes | yes | yes | yes | yes | `effort` | yes | model-dependent Responses hosted tools, remote MCP, shell/apply patch harness | Tier A |"
      ],
      [
        "| Azure OpenAI | yes | yes | yes | native | yes | no | no | no | no | `effort` | yes | model-dependent Responses hosted tools, remote MCP, shell/apply patch harness | Tier A |",
        "| Azure OpenAI | yes | yes | yes | native | yes | yes | yes | yes | no | `effort` | yes | model-dependent Responses hosted tools, remote MCP, shell/apply patch harness | Tier A |"
      ],
      [
        "| Gemini | yes | yes | yes | native | yes | no | no | no | no | model-dependent | yes | native | Tier B |",
        "| Gemini | yes | yes | yes | native | yes | yes | yes | yes | yes | model-dependent | yes | native | Tier B |"
      ],
      [
        "| Vertex | yes | yes | yes | native | yes | no | no | no | no | model-dependent | yes | native | Tier B |",
        "| Vertex | yes | yes | yes | native | yes | yes | yes | yes | no | model-dependent | yes | native | Tier B |"
      ],
      [
        "| Kimi | yes | yes | yes | native | no | no | no | no | no | model-dependent | no | Formula tools via Chat Completions | Tier C |",
        "| Kimi | yes | yes | yes | native | no | no | no | no | no | model-dependent | Formula tool | Formula tools via Chat Completions | Tier C |"
      ],
      [
        "| Bedrock | yes | yes | yes | native | no | no | no | no | no | endpoint-dependent | no | Converse baseline or Mantle/OpenAI-compatible Responses hosted tools and remote MCP | Tier C |",
        "| Bedrock | yes | yes | partial / endpoint-dependent | native | no | no | no | no | no | endpoint-dependent | endpoint-dependent | Converse baseline or Mantle/OpenAI-compatible Responses hosted tools and remote MCP | Tier C / A by runtime |"
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
      azure("gpt-4o-mini"),
      anthropic("claude-3-5-sonnet"),
      gemini("gemini-3.5-flash"),
      vertex("gemini-3.5-flash"),
      qwen("qwen-plus"),
      deepseek("deepseek-v4-flash"),
      openrouter("openai/gpt-4o-mini"),
      kimi("kimi-k2.5"),
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
