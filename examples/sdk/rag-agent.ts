import {
  chunkText,
  createAgent,
  createRetrievalContextMessage,
  embedRetrievalDocuments,
  rankRetrievedDocuments,
  retrieveContext,
  runAgent,
  user,
  type EmbeddedRetrievalDocument,
  type EmbeddingModel,
  type LanguageModel,
  type Retriever,
  type VectorStore
} from "../../packages/sdk/src/index";

import { section } from "../_shared";

const capabilities: LanguageModel["capabilities"] = {
  streaming: false,
  tools: false,
  structuredOutput: false,
  jsonMode: false,
  toolChoice: false,
  parallelToolCalls: false,
  vision: false,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: true,
  reasoning: false,
  webSearch: false
};

const vocabulary = ["madrid", "museum", "billing", "security", "order"];

const vectorize = (value: string): number[] => {
  const normalized = value.toLowerCase();
  return vocabulary.map((term) => (normalized.match(new RegExp(`\\b${term}s?\\b`, "g")) ?? []).length);
};

const embeddingModel: EmbeddingModel = {
  provider: "example",
  modelId: "deterministic-retrieval-embedder",
  capabilities,
  async embed(input) {
    return {
      embeddings: input.values.map(vectorize)
    };
  }
};

const model: LanguageModel = {
  provider: "example",
  modelId: "deterministic-rag-agent",
  capabilities,
  async generate(input) {
    const context = input.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const answer = context.toLowerCase().includes("madrid") && context.toLowerCase().includes("museum")
      ? "The user prefers museums in Madrid."
      : "I do not have enough retrieved context.";

    return {
      text: answer,
      finishReason: "stop",
      messages: [
        {
          role: "assistant",
          parts: [{ type: "text", text: answer }]
        }
      ]
    };
  }
};

const sourceDocuments = [
  ...chunkText("User profile: the user prefers museums and quiet walks in Madrid.", {
    idPrefix: "profile",
    metadata: { source: "profile" }
  }),
  ...chunkText("Support guide: billing questions should go to the account team.", {
    idPrefix: "support",
    metadata: { source: "support" }
  }),
  ...chunkText("Security guide: rotate API keys after team member changes.", {
    idPrefix: "security",
    metadata: { source: "security" }
  })
];

const embeddedDocuments = await embedRetrievalDocuments({
  model: embeddingModel,
  documents: sourceDocuments
});

const memory: EmbeddedRetrievalDocument[] = [];
const vectorStore: VectorStore = {
  upsert(documents) {
    memory.push(...documents);
  },
  query(input) {
    return rankRetrievedDocuments(input.embedding, memory, {
      topK: input.topK
    });
  }
};

await vectorStore.upsert(embeddedDocuments);

const retriever: Retriever = {
  async retrieve({ query, topK }) {
    const embeddedQuery = await embeddingModel.embed({ values: [query] });
    return vectorStore.query({
      embedding: embeddedQuery.embeddings[0] ?? [],
      topK
    });
  }
};

const question = "What Madrid museum preference should I remember?";
const retrieved = await retrieveContext({
  retriever,
  query: question,
  topK: 2
});

const agent = createAgent({
  id: "rag-agent-example",
  model
});

section("Retrieved context");
console.log(retrieved);

section("Run RAG-backed agent");
const result = await runAgent(agent, {
  userId: "user_123",
  messages: [
    createRetrievalContextMessage(retrieved, {
      title: "Use this retrieved context to answer the user."
    }),
    user(question)
  ]
});

console.log(result.outputText);
