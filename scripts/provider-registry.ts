/** Maintenance authority only. Providers and Core never import this registry at runtime.
 * Package versions come from each manifest when generating the CLI metadata.
 */
export interface MaintenanceProvider {
  id: string;
  packageName: string;
  factoryName: string;
  envName: string;
  defaultModel: string | null;
  catalogExport: string;
  /** null excludes providers needing a dedicated auth/scaffold implementation. */
  scaffoldOrder: number | null;
}

export const maintenanceProviders = [
  {
    "id": "openai",
    "packageName": "@zhivex-ai/openai",
    "factoryName": "createOpenAI",
    "envName": "OPENAI_API_KEY",
    "defaultModel": "gpt-6-astra",
    "catalogExport": "openaiCatalogFragment",
    "scaffoldOrder": 1
  },
  {
    "id": "xai",
    "packageName": "@zhivex-ai/xai",
    "factoryName": "createXAI",
    "envName": "XAI_API_KEY",
    "defaultModel": "grok-4.5",
    "catalogExport": "xaiCatalogFragment",
    "scaffoldOrder": 2
  },
  {
    "id": "meta",
    "packageName": "@zhivex-ai/meta",
    "factoryName": "createMeta",
    "envName": "MODEL_API_KEY",
    "defaultModel": "muse-spark-1.2",
    "catalogExport": "metaCatalogFragment",
    "scaffoldOrder": 3
  },
  {
    "id": "azure-openai",
    "packageName": "@zhivex-ai/azure-openai",
    "factoryName": "createAzureOpenAI",
    "envName": "AZURE_OPENAI_API_KEY",
    "defaultModel": null,
    "catalogExport": "azureOpenaiCatalogFragment",
    "scaffoldOrder": null
  },
  {
    "id": "anthropic",
    "packageName": "@zhivex-ai/anthropic",
    "factoryName": "createAnthropic",
    "envName": "ANTHROPIC_API_KEY",
    "defaultModel": "claude-sonnet-5",
    "catalogExport": "anthropicCatalogFragment",
    "scaffoldOrder": 4
  },
  {
    "id": "gemini",
    "packageName": "@zhivex-ai/gemini",
    "factoryName": "createGemini",
    "envName": "GEMINI_API_KEY",
    "defaultModel": "gemini-3.6-flash",
    "catalogExport": "geminiCatalogFragment",
    "scaffoldOrder": 5
  },
  {
    "id": "vertex",
    "packageName": "@zhivex-ai/vertex",
    "factoryName": "createVertex",
    "envName": "GOOGLE_CLOUD_PROJECT",
    "defaultModel": "gemini-3.7-flash",
    "catalogExport": "vertexCatalogFragment",
    "scaffoldOrder": 0
  },
  {
    "id": "qwen",
    "packageName": "@zhivex-ai/qwen",
    "factoryName": "createQwen",
    "envName": "QWEN_API_KEY",
    "defaultModel": null,
    "catalogExport": "qwenCatalogFragment",
    "scaffoldOrder": null
  },
  {
    "id": "kimi",
    "packageName": "@zhivex-ai/kimi",
    "factoryName": "createKimi",
    "envName": "KIMI_API_KEY",
    "defaultModel": "kimi-k3",
    "catalogExport": "kimiCatalogFragment",
    "scaffoldOrder": 6
  },
  {
    "id": "deepseek",
    "packageName": "@zhivex-ai/deepseek",
    "factoryName": "createDeepSeek",
    "envName": "DEEPSEEK_API_KEY",
    "defaultModel": "deepseek-v4-flash",
    "catalogExport": "deepseekCatalogFragment",
    "scaffoldOrder": 7
  },
  {
    "id": "zai",
    "packageName": "@zhivex-ai/zai",
    "factoryName": "createZAI",
    "envName": "ZAI_API_KEY",
    "defaultModel": "glm-5.3",
    "catalogExport": "zaiCatalogFragment",
    "scaffoldOrder": 8
  },
  {
    "id": "openrouter",
    "packageName": "@zhivex-ai/openrouter",
    "factoryName": "createOpenRouter",
    "envName": "OPENROUTER_API_KEY",
    "defaultModel": null,
    "catalogExport": "openrouterCatalogFragment",
    "scaffoldOrder": null
  },
  {
    "id": "bedrock",
    "packageName": "@zhivex-ai/bedrock",
    "factoryName": "createBedrock",
    "envName": "AWS_ACCESS_KEY_ID",
    "defaultModel": null,
    "catalogExport": "bedrockCatalogFragment",
    "scaffoldOrder": null
  },
  {
    "id": "ollama",
    "packageName": "@zhivex-ai/ollama",
    "factoryName": "createOllama",
    "envName": "OLLAMA_BASE_URL",
    "defaultModel": null,
    "catalogExport": "ollamaCatalogFragment",
    "scaffoldOrder": null
  }
] as const satisfies readonly MaintenanceProvider[];
