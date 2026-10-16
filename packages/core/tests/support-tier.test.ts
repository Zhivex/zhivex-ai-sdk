import { describe, expect, it, vi } from "vitest";

import {
  deriveAgentSupportTier,
  TIER_A_MINIMUM_HOSTED_TOOLS,
  type ModelCapabilities
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
const vertex = createVertex({
  apiKey: "test",
  projectId: "test",
  location: "us-central1",
  fetch: fetchMock as typeof fetch
});
const vertexBearer = createVertex({
  accessToken: "test",
  projectId: "test",
  location: "us-central1",
  fetch: fetchMock as typeof fetch
});
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

const flags = (
  patch: Partial<ModelCapabilities> & { agentCapabilities?: Partial<NonNullable<ModelCapabilities["agentCapabilities"]>> } = {}
): ModelCapabilities => ({
  streaming: true,
  tools: true,
  structuredOutput: true,
  jsonMode: true,
  toolChoice: true,
  parallelToolCalls: false,
  vision: false,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
  reasoning: false,
  webSearch: false,
  ...patch,
  agentCapabilities: {
    supportTier: "tier-c",
    toolChoiceNone: false,
    approvalRequests: false,
    hostedWebSearch: false,
    hostedFileSearch: false,
    remoteMcp: false,
    computerUse: false,
    codeExecution: false,
    toolsets: false,
    ...patch.agentCapabilities
  }
});

const surfaces: Array<{ label: string; capabilities: ModelCapabilities }> = [
  { label: "openai/gpt-4o-mini", capabilities: openai("gpt-4o-mini").capabilities },
  { label: "openai/private-model", capabilities: openai("private-model").capabilities },
  { label: "openai/whisper-1", capabilities: openai.transcriptionModel!("whisper-1").capabilities },
  { label: "openai/tts-1", capabilities: openai.speechModel!("tts-1").capabilities },
  { label: "openai/gpt-image-2", capabilities: openai.imageGenerationModel!("gpt-image-2").capabilities },
  { label: "openai/gpt-realtime", capabilities: openai.realtimeModel!("gpt-realtime").capabilities },
  { label: "openai/gpt-realtime-translate", capabilities: openai.realtimeModel!("gpt-realtime-translate").capabilities },
  { label: "openai/gpt-realtime-whisper", capabilities: openai.realtimeModel!("gpt-realtime-whisper").capabilities },
  { label: "xai/grok-4.5", capabilities: xai("grok-4.5").capabilities },
  { label: "xai/grok-imagine-image", capabilities: xai.imageGenerationModel!("grok-imagine-image").capabilities },
  { label: "meta/muse-spark-1.2", capabilities: meta("muse-spark-1.2").capabilities },
  { label: "azure-openai/gpt-4o-mini", capabilities: azure("gpt-4o-mini").capabilities },
  { label: "azure-openai/whisper", capabilities: azure.transcriptionModel!("whisper").capabilities },
  { label: "azure-openai/gpt-realtime", capabilities: azure.realtimeModel!("gpt-realtime").capabilities },
  { label: "anthropic/claude-opus-5", capabilities: anthropic("claude-opus-5").capabilities },
  { label: "gemini/gemini-3.5-flash", capabilities: gemini("gemini-3.5-flash").capabilities },
  { label: "gemini/gemini-3.1-flash-live-preview", capabilities: gemini.realtimeModel!("gemini-3.1-flash-live-preview").capabilities },
  { label: "gemini/gemini-3.5-live-translate-preview", capabilities: gemini.realtimeModel!("gemini-3.5-live-translate-preview").capabilities },
  { label: "gemini/gemini-3.5-transcribe-live", capabilities: gemini.realtimeModel!("gemini-3.5-transcribe-live").capabilities },
  { label: "vertex/gemini-3.5-flash", capabilities: vertex("gemini-3.5-flash").capabilities },
  { label: "vertex/gemini-live-2.5-flash-native-audio", capabilities: vertex.realtimeModel!("gemini-live-2.5-flash-native-audio").capabilities },
  { label: "vertex/gemini-3.5-live-translate-preview", capabilities: vertex.realtimeModel!("gemini-3.5-live-translate-preview").capabilities },
  { label: "vertex/gemini-3.5-transcribe-live-preview", capabilities: vertex.realtimeModel!("gemini-3.5-transcribe-live-preview").capabilities },
  { label: "vertex/claude-opus-5", capabilities: vertexBearer("claude-opus-5").capabilities },
  { label: "vertex-chat/meta/llama-3.3-70b-instruct-maas", capabilities: vertexBearer.chatModel("meta/llama-3.3-70b-instruct-maas").capabilities },
  { label: "vertex-chat/unknown", capabilities: vertexBearer.chatModel("custom-model", { endpoint: "42" }).capabilities },
  { label: "vertex-chat/deepseek-ai/deepseek-r1", capabilities: vertexBearer.chatModel("deepseek-ai/deepseek-r1").capabilities },
  { label: "openrouter/openai/gpt-4o-mini", capabilities: openrouter("openai/gpt-4o-mini").capabilities },
  { label: "openrouter/private-model", capabilities: openrouter("private-model").capabilities },
  { label: "qwen/qwen-plus", capabilities: qwen("qwen-plus").capabilities },
  { label: "qwen/qwen3.5-omni-plus", capabilities: qwen("qwen3.5-omni-plus").capabilities },
  { label: "qwen/qwen3-asr-flash", capabilities: qwen("qwen3-asr-flash").capabilities },
  { label: "qwen/deepseek-v4-flash", capabilities: qwen("deepseek-v4-flash").capabilities },
  { label: "qwen/qwen3.8-omni-flash-realtime", capabilities: qwen.realtimeModel("qwen3.8-omni-flash-realtime").capabilities },
  { label: "qwen/qwen-audio-3.0-realtime-flash", capabilities: qwen.realtimeModel("qwen-audio-3.0-realtime-flash").capabilities },
  { label: "qwen/qwen3.8-livetranslate-flash-realtime", capabilities: qwen.realtimeModel("qwen3.8-livetranslate-flash-realtime").capabilities },
  { label: "kimi/kimi-k3", capabilities: kimi("kimi-k3").capabilities },
  { label: "deepseek/deepseek-v4-flash", capabilities: deepseek("deepseek-v4-flash").capabilities },
  { label: "zai/glm-5.3", capabilities: zai("glm-5.3").capabilities },
  { label: "bedrock/converse", capabilities: bedrockConverse("anthropic.claude-3-5-sonnet").capabilities },
  { label: "bedrock/openai", capabilities: bedrockOpenAI("openai.gpt-oss-120b-1:0").capabilities },
  { label: "ollama/llama3.2", capabilities: ollama("llama3.2").capabilities }
];

describe("agent support tier derivation", () => {
  it("uses hosted web search as the text Tier A floor", () => {
    expect(TIER_A_MINIMUM_HOSTED_TOOLS).toEqual(["hostedWebSearch"]);
  });

  it("requires approval-capable remote MCP and the hosted-tool floor for Tier A", () => {
    expect(deriveAgentSupportTier(flags({
      agentCapabilities: { remoteMcp: true, approvalRequests: true, hostedWebSearch: true, durableAgent: true }
    }))).toBe("tier-a");
    expect(deriveAgentSupportTier(flags({
      agentCapabilities: { remoteMcp: true, approvalRequests: false, hostedWebSearch: true, durableAgent: true }
    }))).toBe("tier-b");
    expect(deriveAgentSupportTier(flags({
      agentCapabilities: { remoteMcp: false, approvalRequests: true, hostedWebSearch: true, durableAgent: true }
    }))).toBe("tier-b");
    expect(deriveAgentSupportTier(flags({
      agentCapabilities: { remoteMcp: true, approvalRequests: true, hostedWebSearch: false, durableAgent: true }
    }))).toBe("tier-b");
    expect(deriveAgentSupportTier(flags({
      tools: false,
      agentCapabilities: { remoteMcp: true, approvalRequests: true, hostedWebSearch: true, durableAgent: true }
    }))).toBe("tier-c");
  });

  it("treats a tool-capable realtime session with MCP approvals as the Tier A equivalent", () => {
    const realtime = {
      sessions: true,
      audioInput: true,
      audioOutput: true,
      imageInput: false,
      tools: true,
      browserTokens: false
    };
    expect(deriveAgentSupportTier(flags({
      realtime,
      agentCapabilities: { remoteMcp: true, approvalRequests: true, hostedWebSearch: false }
    }))).toBe("tier-a");
    expect(deriveAgentSupportTier(flags({
      realtime: { ...realtime, tools: false },
      tools: false,
      agentCapabilities: { remoteMcp: true, approvalRequests: true, hostedWebSearch: false }
    }))).toBe("tier-c");
  });

  it("requires tool calling and durableAgent for Tier B", () => {
    expect(deriveAgentSupportTier(flags({ agentCapabilities: { durableAgent: true } }))).toBe("tier-b");
    expect(deriveAgentSupportTier(flags({ agentCapabilities: { durableAgent: false } }))).toBe("tier-c");
    expect(deriveAgentSupportTier(flags({ tools: false, agentCapabilities: { durableAgent: true } }))).toBe("tier-c");
  });

  it("matches every provider surface declaration", () => {
    const mismatches = surfaces.flatMap(({ label, capabilities }) => {
      const declared = capabilities.agentCapabilities?.supportTier ?? "tier-c";
      const derived = deriveAgentSupportTier(capabilities);
      return declared === derived ? [] : [`${label}: declared ${declared}, derived ${derived}`];
    });
    expect(mismatches).toEqual([]);
  });
});
