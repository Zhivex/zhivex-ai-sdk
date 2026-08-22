import { defineModelCatalogFragment } from "../fragment.js";

export const qwenCatalogFragment = defineModelCatalogFragment({
  provider: "qwen",
  revision: "2026-08-16",
  verifiedAt: "2026-08-16",
  pricingEffectiveAt: "2026-08-16",
  sources: ["catalog-release:2026-08-16"],
  entries: [
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
