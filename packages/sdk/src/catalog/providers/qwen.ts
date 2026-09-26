import { defineModelCatalogFragment } from "../fragment.js";

export const qwenCatalogFragment = defineModelCatalogFragment({
  provider: "qwen",
  revision: "2026-09-26",
  verifiedAt: "2026-09-26",
  pricingEffectiveAt: "2026-09-18",
  sources: [
    "https://docs.qwencloud.com/api-reference/decision-model-api",
    "https://docs.qwencloud.com/developer-guides/getting-started/model-selection",
    "https://docs.qwencloud.com/developer-guides/embeddings/embedding",
    "https://docs.qwencloud.com/api-reference/real-time-multimodal/client-events",
    "https://docs.qwencloud.com/api-reference/world-model/happyoyster-auth-setup",
    "https://www.alibabacloud.com/help/en/model-studio/qwen3-5-livetranslate-flash-realtime",
    "https://docs.qwencloud.com/api-reference/chat/openai-chat",
    "https://docs.qwencloud.com/api-reference/chat/openai-responses",
    "https://www.alibabacloud.com/help/en/model-studio/models",
    "https://www.qwencloud.com/models/qwen3.8-omni-flash",
    "https://docs.qwencloud.com/changelog/models",
    "https://www.qwencloud.com/models/qwen3.8-flash",
    "https://docs.qwencloud.com/developer-guides/getting-started/text-generation-models"
  ],
  entries: [
    // Discovery is not a claim that every account, transport or feature is live-certified.
    { provider: "qwen", modelId: "decision-model-preview" },
    { provider: "qwen", modelId: "qwen3.8-omni-flash-realtime" },
    { provider: "qwen", modelId: "qwen-audio-3.1-realtime-plus" },
    { provider: "qwen", modelId: "qwen-audio-3.0-realtime-plus" },
    { provider: "qwen", modelId: "qwen-audio-3.0-realtime-flash" },
    { provider: "qwen", modelId: "qwen-audio-3.0-tts-plus" },
    { provider: "qwen", modelId: "qwen-audio-3.0-tts-flash" },
    { provider: "qwen", modelId: "qwen-audio-3.0-asr-flash" },
    { provider: "qwen", modelId: "qwen-audio-3.0-asr-flash-streaming" },
    { provider: "qwen", modelId: "qwen-audio-3.0-asr-flash-filetrans" },
    { provider: "qwen", modelId: "qwen-audio-3.1-asr-flash-streaming" },
    { provider: "qwen", modelId: "qwen-audio-3.1-asr-flash-filetrans" },
    { provider: "qwen", modelId: "qwen-image-3.0-pro" },
    { provider: "qwen", modelId: "qwen-image-3.0" },
    { provider: "qwen", modelId: "qwen3.8-27b" },
    { provider: "qwen", modelId: "qwen3.7-flash" },
    { provider: "qwen", modelId: "qwen3.7-flash-2026-07-15" },
    { provider: "qwen", modelId: "qwen3.8-max-2026-09-02" },
    { provider: "qwen", modelId: "qwen3.7-text-embedding" },
    { provider: "qwen", modelId: "text-embedding-v4" },
    { provider: "qwen", modelId: "text-embedding-v3" },
    { provider: "qwen", modelId: "tongyi-embedding-vision-flash" },
    { provider: "qwen", modelId: "qwen-flash-character" },
    { provider: "qwen", modelId: "qwen-plus-character" },
    { provider: "qwen", modelId: "qwen-plus-character-ja" },
    { provider: "qwen", modelId: "qwen-mt-plus" },
    { provider: "qwen", modelId: "qwen-mt-turbo" },
    { provider: "qwen", modelId: "qwen-mt-flash" },
    { provider: "qwen", modelId: "qwen-mt-lite" },
    { provider: "qwen", modelId: "qwen-mt-image-2.0" },
    { provider: "qwen", modelId: "wan3.0-video" },
    { provider: "qwen", modelId: "wan3.0-video-prime" },
    { provider: "qwen", modelId: "happyhorse-1.1-t2v" },
    { provider: "qwen", modelId: "happyhorse-1.1-i2v" },
    { provider: "qwen", modelId: "happyhorse-1.1-r2v" },
    { provider: "qwen", modelId: "happyhorse-1.0-video-edit" },
    { provider: "qwen", modelId: "happyoyster-1.0-adventure" },
    { provider: "qwen", modelId: "happyoyster-1.0-directing" },
    { provider: "qwen", modelId: "happyoyster-1.0-acting" },
    { provider: "qwen", modelId: "vidu/viduq3-mix_reference2video" },
    { provider: "qwen", modelId: "vidu/viduq3-ad_reference2video" },
    { provider: "qwen", modelId: "vidu/viduq3-drama_reference2video" },
    { provider: "qwen", modelId: "vidu/viduq2-pro-fast_img2video" },
    { provider: "qwen", modelId: "vidu/vidu-image_reference2image" },

    { provider: "qwen", modelId: "qwen3.8-livetranslate-flash-realtime", recommendedFor: ["vision", "speed"] },
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
