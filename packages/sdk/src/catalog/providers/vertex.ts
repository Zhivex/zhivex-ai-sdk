import { defineModelCatalogFragment } from "../fragment.js";

export const vertexCatalogFragment = defineModelCatalogFragment({
  provider: "vertex",
  revision: "2026-09-19",
  verifiedAt: "2026-09-19",
  pricingEffectiveAt: "2026-08-30",
  sources: [
    "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-transcribe",
    "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/vto/virtual-try-on-001",
    "https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/multimodal-embeddings-api",
    "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deprecations/partner-models",
    "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/generate-videos-from-text",
    "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/maas/use-open-models",
    "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/maas/zaiorg/glm-52",
    "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/maas/google/gemma-4-26b-a4b-it",
    "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/maas/openai/gpt-oss-120b",
    "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/llama/llama4-maverick",
    "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/llama/llama4-scout",
    "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/grok",
    "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deprecations/open-models",
    "https://docs.mistral.ai/inference/deployment/cloud-deployments/vertex",
    "https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api",
    "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude/use-claude",
    "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash",
    "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-7-flash",
    "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-7-flash"
  ],
  entries: [
    { provider: "vertex", modelId: "gemini-3.5-transcribe-live-preview" },
    { provider: "vertex", modelId: "gemini-3.5-transcribe-preview" },
    { provider: "vertex", modelId: "virtual-try-on-001" },
    { provider: "vertex", modelId: "multimodalembedding@001" },
    ...["jamba-1.5-mini", "jamba-1.5-large"].map((modelId) => ({ provider: "vertex", modelId: `ai21/${modelId}`, lifecycle: { deprecatedAt: "2025-08-27", retiredAt: "2026-02-27", source: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deprecations/partner-models" } })),
    { provider: "vertex", modelId: "gemini-omni-flash-preview" },
    { provider: "vertex", modelId: "gemini-omni-1.1-flash-preview" },
    { provider: "vertex", modelId: "zai-org/glm-5.2-maas" },
    { provider: "vertex", modelId: "google/gemma-4-26b-a4b-it-maas" },
    { provider: "vertex", modelId: "openai/gpt-oss-120b-maas" },
    { provider: "vertex", modelId: "meta/llama-4-maverick-17b-128e-instruct-maas" },
    { provider: "vertex", modelId: "meta/llama-4-scout-17b-16e-instruct-maas" },
    { provider: "vertex", modelId: "xai/grok-4.6" },
    { provider: "vertex", modelId: "xai/grok-4.3" },
    { provider: "vertex", modelId: "xai/grok-4.20-reasoning" },
    { provider: "vertex", modelId: "xai/grok-4.20-non-reasoning" },
    { provider: "vertex", modelId: "xai/grok-4.1-fast-reasoning", lifecycle: { retiredAt: "2026-08-20", source: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/grok/grok-4-1-fast" } },
    { provider: "vertex", modelId: "xai/grok-4.1-fast-non-reasoning", lifecycle: { retiredAt: "2026-08-20", source: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/grok/grok-4-1-fast" } },
    { provider: "vertex", modelId: "intfloat/multilingual-e5-small-maas", lifecycle: { deprecatedAt: "2026-07-21", retiredAt: "2026-10-21", source: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deprecations/open-models" } },
    { provider: "vertex", modelId: "intfloat/multilingual-e5-large-instruct-maas", lifecycle: { deprecatedAt: "2026-07-21", retiredAt: "2026-10-21", source: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deprecations/open-models" } },
    { provider: "vertex", modelId: "deepseek-ai/deepseek-ocr-maas", lifecycle: { deprecatedAt: "2026-07-21", retiredAt: "2026-10-21", source: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deprecations/open-models" } },
    { provider: "vertex", modelId: "deepseek-ai/deepseek-r1-0528-maas", lifecycle: { deprecatedAt: "2026-07-21", retiredAt: "2026-10-21", source: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deprecations/open-models" } },
    { provider: "vertex", modelId: "deepseek-ai/deepseek-v3.2-maas", lifecycle: { deprecatedAt: "2026-07-21", retiredAt: "2026-10-21", source: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deprecations/open-models" } },
    { provider: "vertex", modelId: "deepseek-ai/deepseek-v3.1-maas", lifecycle: { deprecatedAt: "2026-07-21", retiredAt: "2026-10-21", source: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deprecations/open-models" } },
    { provider: "vertex", modelId: "zai-org/glm-5-maas", lifecycle: { deprecatedAt: "2026-07-21", retiredAt: "2026-10-21", source: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deprecations/open-models" } },
    { provider: "vertex", modelId: "zai-org/glm-4.7-maas", lifecycle: { deprecatedAt: "2026-07-21", retiredAt: "2026-10-21", source: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deprecations/open-models" } },
    { provider: "vertex", modelId: "openai/gpt-oss-20b-maas", lifecycle: { deprecatedAt: "2026-07-21", retiredAt: "2026-10-21", source: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deprecations/open-models" } },
    { provider: "vertex", modelId: "moonshotai/kimi-k2-thinking-maas", aliases: ["moonshot-ai/kimi-k2-thinking-maas"], lifecycle: { deprecatedAt: "2026-07-21", retiredAt: "2026-10-21", source: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deprecations/open-models" } },
    { provider: "vertex", modelId: "meta/llama-3.3-70b-instruct-maas", lifecycle: { deprecatedAt: "2026-07-21", retiredAt: "2026-10-21", source: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deprecations/open-models" } },
    { provider: "vertex", modelId: "minimaxai/minimax-m2-maas", lifecycle: { deprecatedAt: "2026-07-21", retiredAt: "2026-10-21", source: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deprecations/open-models" } },
    { provider: "vertex", modelId: "qwen/qwen3-235b-a22b-instruct-2507-maas", lifecycle: { deprecatedAt: "2026-07-21", retiredAt: "2026-10-21", source: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deprecations/open-models" } },
    { provider: "vertex", modelId: "qwen/qwen3-coder-480b-a35b-instruct-maas", lifecycle: { deprecatedAt: "2026-07-21", retiredAt: "2026-10-21", source: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deprecations/open-models" } },
    { provider: "vertex", modelId: "qwen/qwen3-next-80b-a3b-instruct-maas", lifecycle: { deprecatedAt: "2026-07-21", retiredAt: "2026-10-21", source: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deprecations/open-models" } },
    { provider: "vertex", modelId: "qwen/qwen3-next-80b-a3b-thinking-maas", lifecycle: { deprecatedAt: "2026-07-21", retiredAt: "2026-10-21", source: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deprecations/open-models" } },
    { provider: "vertex", modelId: "mistralai/mistral-medium-3" },
    { provider: "vertex", modelId: "mistralai/mistral-small-2503" },
    { provider: "vertex", modelId: "mistralai/codestral-2" },
    { provider: "vertex", modelId: "mistralai/mistral-ocr-2505" },
    { provider: "vertex", modelId: "lyria-3-clip-preview" },
    { provider: "vertex", modelId: "lyria-3-pro-preview" },

    // Host-specific entries: do not inherit Anthropic API pricing or recommendations.
    { provider: "vertex", modelId: "claude-sonnet-4-6" },
    { provider: "vertex", modelId: "claude-opus-4-6" },
    { provider: "vertex", modelId: "claude-sonnet-5" },
    { provider: "vertex", modelId: "claude-opus-5" },
    { provider: "vertex", modelId: "claude-fable-5-1" },
    {
      "provider": "vertex",
      "modelId": "gemini-3.8-flash",
      "recommendedFor": [
        "chat",
        "reasoning",
        "speed",
        "vision",
        "tools"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "gemini-3.7-flash",
      "inputCostPer1kTokens": 0.0015,
      "cachedInputCostPer1kTokens": 0.00015,
      "outputCostPer1kTokens": 0.0075,
      "recommendedFor": [
        "chat",
        "reasoning",
        "speed",
        "vision",
        "tools"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "gemini-3.6-flash",
      "inputCostPer1kTokens": 0.0015,
      "cachedInputCostPer1kTokens": 0.00015,
      "outputCostPer1kTokens": 0.0075,
      "recommendedFor": [
        "chat",
        "reasoning",
        "speed",
        "vision",
        "tools"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "gemini-3.5-flash-lite",
      "inputCostPer1kTokens": 0.0003,
      "cachedInputCostPer1kTokens": 3e-05,
      "outputCostPer1kTokens": 0.0025,
      "recommendedFor": [
        "chat",
        "reasoning",
        "speed",
        "vision",
        "tools"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "gemini-3.5-flash",
      "aliases": [
        "gemini-flash-latest"
      ],
      "inputCostPer1kTokens": 0.0015,
      "cachedInputCostPer1kTokens": 0.00015,
      "outputCostPer1kTokens": 0.009,
      "recommendedFor": [
        "chat",
        "reasoning",
        "speed",
        "vision",
        "tools"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "gemini-3.5-live-translate-preview",
      "recommendedFor": [
        "speed"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "gemini-3.1-pro-preview",
      "recommendedFor": [
        "chat",
        "reasoning",
        "vision",
        "tools"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "gemini-3.1-flash-lite",
      "recommendedFor": [
        "chat",
        "speed",
        "vision",
        "tools"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "gemini-3.1-flash-lite-image",
      "recommendedFor": [
        "vision",
        "speed"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "gemini-3.1-flash-image",
      "recommendedFor": [
        "vision",
        "speed"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "gemini-3-pro-image",
      "recommendedFor": [
        "vision",
        "reasoning"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "gemini-2.5-flash-image",
      "recommendedFor": [
        "vision",
        "speed"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "gemini-live-2.5-flash-native-audio",
      "recommendedFor": [
        "speed",
        "vision",
        "tools"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "gemini-3.1-flash-tts-preview",
      "recommendedFor": [
        "speed"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "gemini-embedding-2",
      "recommendedFor": [
        "vision"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "veo-3.1-generate-001",
      "recommendedFor": [
        "vision"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "veo-3.1-fast-generate-001",
      "recommendedFor": [
        "vision",
        "speed"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "veo-3.1-lite-generate-001",
      "recommendedFor": [
        "vision",
        "speed"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "lyria-002"
    }
  ]
});
