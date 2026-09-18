import { defineModelCatalogFragment } from "../fragment.js";

export const qwenCatalogFragment = defineModelCatalogFragment({
  provider: "qwen",
  revision: "2026-09-18",
  verifiedAt: "2026-09-18",
  pricingEffectiveAt: "2026-09-18",
  sources: [
    "https://docs.qwencloud.com/api-reference/chat/openai-chat",
    "https://docs.qwencloud.com/api-reference/chat/openai-responses",
    "https://www.alibabacloud.com/help/en/model-studio/models",
    "https://www.qwencloud.com/models/qwen3.8-omni-flash",
    "https://docs.qwencloud.com/changelog/models",
    "https://www.qwencloud.com/models/qwen3.8-flash",
    "https://docs.qwencloud.com/developer-guides/getting-started/text-generation-models"
  ],
  entries: [
    {
      provider: "qwen",
      modelId: "qwen3.8-omni-flash",
      inputCostPer1kTokens: 0.00015,
      outputCostPer1kTokens: 0.00047,
      cachedInputCostPer1kTokens: 0.000016,
      recommendedFor: ["chat", "reasoning", "vision", "tools", "speed"]
    },
    { provider: "qwen", modelId: "deepseek-v4.1-flash" },
    { provider: "qwen", modelId: "deepseek-v4-pro" },
    { provider: "qwen", modelId: "deepseek-v4-flash" },
    { provider: "qwen", modelId: "deepseek-v4-pro-0813" },
    { provider: "qwen", modelId: "deepseek-v4-flash-0731" },
    { provider: "qwen", modelId: "glm-5.2" },
    { provider: "qwen", modelId: "glm-5.3" },
    { provider: "qwen", modelId: "ZHIPU/GLM-5.3" },
    { provider: "qwen", modelId: "kimi-k3" },
    { provider: "qwen", modelId: "MiniMax-M2.5" },

    {
      "provider": "qwen",
      "modelId": "qwen3.8-max-0902",
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools",
        "vision"
      ]
    },
    {
      "provider": "qwen",
      "modelId": "qwen3.8-2.4t-a95b"
    },
    {
      "provider": "qwen",
      "modelId": "qwen3.8-max",
      "recommendedFor": [
        "chat",
        "tools",
        "reasoning",
        "vision"
      ]
    },
    {
      "provider": "qwen",
      "modelId": "qwen3.8-flash",
      "inputCostPer1kTokens": 0.00016,
      "outputCostPer1kTokens": 0.00047,
      "cachedInputCostPer1kTokens": 1.6e-05,
      "recommendedFor": [
        "chat",
        "speed",
        "tools",
        "reasoning",
        "vision"
      ]
    },
    {
      "provider": "qwen",
      "modelId": "qwen3.8-max-preview",
      "recommendedFor": [
        "chat",
        "tools",
        "reasoning",
        "vision"
      ]
    },
    {
      "provider": "qwen",
      "modelId": "qwen3.7-max",
      "costPer1kTokens": 0.0016,
      "recommendedFor": [
        "chat",
        "tools",
        "reasoning"
      ]
    },
    {
      "provider": "qwen",
      "modelId": "qwen3.7-plus",
      "costPer1kTokens": 0.0008,
      "recommendedFor": [
        "chat",
        "tools",
        "reasoning",
        "vision"
      ]
    },
    {
      "provider": "qwen",
      "modelId": "qwen3.6-flash",
      "costPer1kTokens": 0.0002,
      "recommendedFor": [
        "chat",
        "speed",
        "tools",
        "vision"
      ]
    },
    {
      "provider": "qwen",
      "modelId": "qwen3.5-omni-plus",
      "recommendedFor": [
        "chat",
        "vision",
        "speed",
        "tools"
      ]
    },
    {
      "provider": "qwen",
      "modelId": "qwen3.5-omni-plus-realtime",
      "recommendedFor": [
        "vision",
        "speed"
      ]
    },
    {
      "provider": "qwen",
      "modelId": "qwen3.5-ocr",
      "recommendedFor": [
        "vision",
        "speed"
      ]
    },
    {
      "provider": "qwen",
      "modelId": "tongyi-embedding-vision-plus",
      "recommendedFor": [
        "vision"
      ]
    },
    {
      "provider": "qwen",
      "modelId": "qwen3-vl-embedding",
      "recommendedFor": [
        "vision"
      ]
    },
    {
      "provider": "qwen",
      "modelId": "qwen3-rerank"
    },
    {
      "provider": "qwen",
      "modelId": "qwen3-asr-flash",
      "recommendedFor": [
        "speed"
      ]
    },
    {
      "provider": "qwen",
      "modelId": "qwen3-tts-flash",
      "recommendedFor": [
        "speed"
      ]
    },
    {
      "provider": "qwen",
      "modelId": "qwen-image-2.0-pro",
      "recommendedFor": [
        "vision"
      ]
    },
    {
      "provider": "qwen",
      "modelId": "wan2.7-t2v",
      "recommendedFor": [
        "vision"
      ]
    },
    {
      "provider": "qwen",
      "modelId": "qwen-plus",
      "costPer1kTokens": 0.0008,
      "recommendedFor": [
        "chat",
        "tools",
        "reasoning"
      ]
    }
  ]
});
