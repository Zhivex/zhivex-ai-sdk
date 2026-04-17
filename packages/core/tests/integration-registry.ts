import type { EmbeddingModel, LanguageModel, ReasoningConfig, StructuredOutputMode, ToolChoice } from "../src/index.js";
import { createAnthropic } from "../../anthropic/src/index.js";
import { createGemini } from "../../gemini/src/index.js";
import { createOpenAI } from "../../openai/src/index.js";
import { createOpenRouter } from "../../openrouter/src/index.js";
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

const vertexAccessToken = process.env.VERTEX_ACCESS_TOKEN ?? process.env.GOOGLE_ACCESS_TOKEN;
const vertexProjectId = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
const vertexLocation = process.env.VERTEX_LOCATION;
const vertexBaseURL = process.env.VERTEX_BASE_URL;
const vertexTextModelId = process.env.VERTEX_INTEGRATION_MODEL ?? "gemini-2.0-flash";
const vertexEmbeddingModelId = process.env.VERTEX_INTEGRATION_EMBEDDING_MODEL ?? "text-embedding-005";

const hasVertexCredentials = Boolean(vertexAccessToken && (vertexProjectId || vertexBaseURL));

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
  ...(hasVertexCredentials
    ? [
        {
          name: "vertex",
          createModel: () =>
            createVertex({
              accessToken: vertexAccessToken,
              projectId: vertexProjectId,
              location: vertexLocation,
              baseURL: vertexBaseURL
            })(vertexTextModelId),
          createEmbeddingModel: () =>
            createVertex({
              accessToken: vertexAccessToken,
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
