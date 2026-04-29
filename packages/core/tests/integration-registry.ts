import type { EmbeddingModel, LanguageModel, ReasoningConfig, StructuredOutputMode, ToolChoice } from "../src/index.js";
import { createAnthropic } from "../../anthropic/src/index.js";
import { createAzureOpenAI } from "../../azure-openai/src/index.js";
import { createBedrock } from "../../bedrock/src/index.js";
import { createDeepSeek } from "../../deepseek/src/index.js";
import { createGemini } from "../../gemini/src/index.js";
import { createKimi } from "../../kimi/src/index.js";
import { createOpenAI } from "../../openai/src/index.js";
import { createOpenRouter } from "../../openrouter/src/index.js";
import { createQwen } from "../../qwen/src/index.js";
import { createVertex } from "../../vertex/src/index.js";

export interface IntegrationLanguageProvider {
  name: string;
  createModel: () => LanguageModel;
  createEmbeddingModel?: () => EmbeddingModel;
  supports: {
    streaming: boolean;
    tools: boolean;
    structuredOutputMode?: StructuredOutputMode;
    embeddings: boolean;
    reasoning?: ReasoningConfig;
  };
  toolChoiceForTool?: (toolName: string) => ToolChoice;
}

const openAIApiKey = process.env.OPENAI_API_KEY;
const openAIBaseURL = process.env.OPENAI_BASE_URL;
const openAITextModelId = process.env.OPENAI_INTEGRATION_MODEL ?? "gpt-5.4-nano";
const openAIEmbeddingModelId = process.env.OPENAI_INTEGRATION_EMBEDDING_MODEL ?? "text-embedding-3-small";

const azureOpenAIApiKey = process.env.AZURE_OPENAI_API_KEY;
const azureOpenAIEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
const azureOpenAIApiVersion = process.env.AZURE_OPENAI_API_VERSION;
const azureOpenAITextModelId = process.env.AZURE_OPENAI_INTEGRATION_MODEL ?? "gpt-5.4-nano";
const azureOpenAIEmbeddingModelId = process.env.AZURE_OPENAI_INTEGRATION_EMBEDDING_MODEL ?? "text-embedding-3-small";

const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
const anthropicBaseURL = process.env.ANTHROPIC_BASE_URL;
const anthropicVersion = process.env.ANTHROPIC_VERSION;
const anthropicTextModelId = process.env.ANTHROPIC_INTEGRATION_MODEL ?? "claude-3-5-sonnet";
const isAnthropicOpus47OrLaterModel = (modelId: string) =>
  /^(?:claude-opus-4-(?:7|8|9)|claude-opus-[5-9])(?:[-@]|$)/.test(modelId);

const geminiApiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
const geminiBaseURL = process.env.GEMINI_BASE_URL;
const geminiTextModelId = process.env.GEMINI_INTEGRATION_MODEL ?? "gemini-2.0-flash";
const geminiEmbeddingModelId = process.env.GEMINI_INTEGRATION_EMBEDDING_MODEL ?? "text-embedding-004";

const openRouterApiKey = process.env.OPENROUTER_API_KEY;
const openRouterBaseURL = process.env.OPENROUTER_BASE_URL;
const openRouterTextModelId = process.env.OPENROUTER_INTEGRATION_MODEL ?? "openai/gpt-4o-mini";

const deepSeekApiKey = process.env.DEEPSEEK_API_KEY;
const deepSeekBaseURL = process.env.DEEPSEEK_BASE_URL;
const deepSeekTextModelId = process.env.DEEPSEEK_INTEGRATION_MODEL ?? "deepseek-v4-flash";

const qwenApiKey = process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY;
const qwenBaseURL = process.env.QWEN_BASE_URL;
const qwenTextModelId = process.env.QWEN_INTEGRATION_MODEL ?? "qwen-plus";
const qwenEmbeddingModelId = process.env.QWEN_INTEGRATION_EMBEDDING_MODEL ?? "text-embedding-v4";

const kimiApiKey = process.env.KIMI_API_KEY ?? process.env.MOONSHOT_API_KEY;
const kimiBaseURL = process.env.KIMI_BASE_URL ?? process.env.MOONSHOT_BASE_URL;
const kimiTextModelId = process.env.KIMI_INTEGRATION_MODEL ?? "kimi-k2.5";

const bedrockRegion = process.env.AWS_REGION;
const bedrockTextModelId = process.env.BEDROCK_INTEGRATION_MODEL ?? "anthropic.claude-3-5-sonnet";
const bedrockOpenAIBaseURL = process.env.BEDROCK_OPENAI_BASE_URL;
const bedrockOpenAIApiKey = process.env.BEDROCK_API_KEY ?? process.env.AWS_BEARER_TOKEN_BEDROCK;
const bedrockOpenAITextModelId = process.env.BEDROCK_OPENAI_INTEGRATION_MODEL ?? "openai.gpt-oss-120b-1:0";

const vertexAccessToken = process.env.VERTEX_ACCESS_TOKEN ?? process.env.GOOGLE_ACCESS_TOKEN;
const vertexApiKey = process.env.VERTEX_API_KEY ?? process.env.GOOGLE_API_KEY;
const vertexProjectId = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
const vertexLocation = process.env.VERTEX_LOCATION ?? process.env.GOOGLE_CLOUD_LOCATION;
const vertexBaseURL = process.env.VERTEX_BASE_URL;
const vertexTextModelId = process.env.VERTEX_INTEGRATION_MODEL ?? "gemini-2.0-flash";
const vertexEmbeddingModelId = process.env.VERTEX_INTEGRATION_EMBEDDING_MODEL ?? "text-embedding-005";
const usableVertexAccessToken = vertexAccessToken && (vertexProjectId || vertexBaseURL) ? vertexAccessToken : undefined;

const hasVertexCredentials = Boolean(usableVertexAccessToken || vertexApiKey);

export const integrationLanguageProviders: IntegrationLanguageProvider[] = [
  ...(openAIApiKey
    ? [
        {
          name: "openai",
          createModel: () =>
            createOpenAI({
              apiKey: openAIApiKey,
              baseURL: openAIBaseURL
            })(openAITextModelId),
          createEmbeddingModel: () =>
            createOpenAI({
              apiKey: openAIApiKey,
              baseURL: openAIBaseURL
            }).embeddingModel(openAIEmbeddingModelId),
          supports: {
            streaming: true,
            tools: true,
            structuredOutputMode: "native",
            embeddings: true,
            reasoning: {
              effort: "low"
            }
          },
          toolChoiceForTool: (toolName) => ({
            type: "tool",
            toolName
          })
        } satisfies IntegrationLanguageProvider
      ]
    : []),
  ...(azureOpenAIApiKey && azureOpenAIEndpoint
    ? [
        {
          name: "azure-openai",
          createModel: () =>
            createAzureOpenAI({
              apiKey: azureOpenAIApiKey,
              endpoint: azureOpenAIEndpoint,
              apiVersion: azureOpenAIApiVersion
            })(azureOpenAITextModelId),
          createEmbeddingModel: () =>
            createAzureOpenAI({
              apiKey: azureOpenAIApiKey,
              endpoint: azureOpenAIEndpoint,
              apiVersion: azureOpenAIApiVersion
            }).embeddingModel(azureOpenAIEmbeddingModelId),
          supports: {
            streaming: true,
            tools: true,
            structuredOutputMode: "native",
            embeddings: true,
            reasoning: {
              effort: "low"
            }
          },
          toolChoiceForTool: (toolName) => ({
            type: "tool",
            toolName
          })
        } satisfies IntegrationLanguageProvider
      ]
    : []),
  ...(anthropicApiKey
    ? [
        {
          name: "anthropic",
          createModel: () =>
            createAnthropic({
              apiKey: anthropicApiKey,
              baseURL: anthropicBaseURL,
              anthropicVersion
            })(anthropicTextModelId),
          supports: {
            streaming: true,
            tools: true,
            structuredOutputMode: "prompted",
            embeddings: false,
            reasoning: isAnthropicOpus47OrLaterModel(anthropicTextModelId)
              ? {
                  effort: "low"
                }
              : {
                  budgetTokens: 256
                }
          },
          toolChoiceForTool: () => "required"
        } satisfies IntegrationLanguageProvider
      ]
    : []),
  ...(geminiApiKey
    ? [
        {
          name: "gemini",
          createModel: () =>
            createGemini({
              apiKey: geminiApiKey,
              baseURL: geminiBaseURL
            })(geminiTextModelId),
          createEmbeddingModel: () =>
            createGemini({
              apiKey: geminiApiKey,
              baseURL: geminiBaseURL
            }).embeddingModel(geminiEmbeddingModelId),
          supports: {
            streaming: true,
            tools: true,
            structuredOutputMode: "native",
            embeddings: true,
            reasoning: {
              budgetTokens: 256
            }
          },
          toolChoiceForTool: (toolName) => ({
            type: "tool",
            toolName
          })
        } satisfies IntegrationLanguageProvider
      ]
    : []),
  ...(openRouterApiKey
    ? [
        {
          name: "openrouter",
          createModel: () =>
            createOpenRouter({
              apiKey: openRouterApiKey,
              baseURL: openRouterBaseURL
            })(openRouterTextModelId),
          supports: {
            streaming: true,
            tools: true,
            structuredOutputMode: "native",
            embeddings: false,
            reasoning: {
              effort: "low",
              budgetTokens: 256
            }
          },
          toolChoiceForTool: (toolName) => ({
            type: "tool",
            toolName
          })
        } satisfies IntegrationLanguageProvider
      ]
    : []),
  ...(deepSeekApiKey
    ? [
        {
          name: "deepseek",
          createModel: () =>
            createDeepSeek({
              apiKey: deepSeekApiKey,
              baseURL: deepSeekBaseURL
            })(deepSeekTextModelId),
          supports: {
            streaming: true,
            tools: true,
            structuredOutputMode: "native",
            embeddings: false,
            reasoning: {
              effort: "high"
            }
          },
          toolChoiceForTool: (toolName) => ({
            type: "tool",
            toolName
          })
        } satisfies IntegrationLanguageProvider
      ]
    : []),
  ...(qwenApiKey
    ? [
        {
          name: "qwen",
          createModel: () =>
            createQwen({
              apiKey: qwenApiKey,
              baseURL: qwenBaseURL
            })(qwenTextModelId),
          createEmbeddingModel: () =>
            createQwen({
              apiKey: qwenApiKey,
              baseURL: qwenBaseURL
            }).embeddingModel(qwenEmbeddingModelId),
          supports: {
            streaming: true,
            tools: true,
            structuredOutputMode: "native",
            embeddings: true,
            reasoning: {
              effort: "low"
            }
          },
          toolChoiceForTool: (toolName) => ({
            type: "tool",
            toolName
          })
        } satisfies IntegrationLanguageProvider
      ]
    : []),
  ...(kimiApiKey
    ? [
        {
          name: "kimi",
          createModel: () =>
            createKimi({
              apiKey: kimiApiKey,
              baseURL: kimiBaseURL
            })(kimiTextModelId),
          supports: {
            streaming: true,
            tools: true,
            structuredOutputMode: "native",
            embeddings: false,
            reasoning: {
              effort: "low"
            }
          },
          toolChoiceForTool: (toolName) => ({
            type: "tool",
            toolName
          })
        } satisfies IntegrationLanguageProvider
      ]
    : []),
  ...(bedrockRegion
    ? [
        {
          name: "bedrock-converse",
          createModel: () =>
            createBedrock({
              region: bedrockRegion
            })(bedrockTextModelId),
          supports: {
            streaming: true,
            tools: true,
            structuredOutputMode: "native",
            embeddings: false
          },
          toolChoiceForTool: (toolName) => ({
            type: "tool",
            toolName
          })
        } satisfies IntegrationLanguageProvider
      ]
    : []),
  ...(bedrockOpenAIBaseURL && bedrockOpenAIApiKey
    ? [
        {
          name: "bedrock-openai",
          createModel: () =>
            createBedrock({
              runtime: "openai",
              baseURL: bedrockOpenAIBaseURL,
              apiKey: bedrockOpenAIApiKey
            })(bedrockOpenAITextModelId),
          supports: {
            streaming: true,
            tools: true,
            structuredOutputMode: "native",
            embeddings: false,
            reasoning: {
              effort: "low"
            }
          },
          toolChoiceForTool: (toolName) => ({
            type: "tool",
            toolName
          })
        } satisfies IntegrationLanguageProvider
      ]
    : []),
  ...(hasVertexCredentials
    ? [
        {
          name: "vertex",
          createModel: () =>
            createVertex({
              accessToken: usableVertexAccessToken,
              apiKey: vertexApiKey,
              projectId: vertexProjectId,
              location: vertexLocation,
              baseURL: vertexBaseURL
            })(vertexTextModelId),
          createEmbeddingModel: () =>
            createVertex({
              accessToken: usableVertexAccessToken,
              apiKey: vertexApiKey,
              projectId: vertexProjectId,
              location: vertexLocation,
              baseURL: vertexBaseURL
            }).embeddingModel(vertexEmbeddingModelId),
          supports: {
            streaming: true,
            tools: true,
            structuredOutputMode: "native",
            embeddings: true,
            reasoning: {
              budgetTokens: 256
            }
          },
          toolChoiceForTool: (toolName) => ({
            type: "tool",
            toolName
          })
        } satisfies IntegrationLanguageProvider
      ]
    : [])
];
