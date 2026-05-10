# RAG And Semantic Memory

Zhivex keeps RAG as a small, stable contract layer. The SDK owns portable documents, embedding, ranking, retrieval, and context-injection helpers. Your application owns the vector store, database driver, tenancy, auth, and persistence.

## Basic Flow

```text
source text -> chunkText()
  -> embedRetrievalDocuments()
  -> app-owned VectorStore
  -> retrieveContext()
  -> createRetrievalContextMessage()
  -> runAgent() or Runner
```

```ts
import {
  chunkText,
  createRetrievalContextMessage,
  embedRetrievalDocuments,
  rankRetrievedDocuments,
  retrieveContext,
  runAgent
} from "@zhivex-ai/sdk";

const chunks = chunkText(policyText, {
  idPrefix: "policy",
  metadata: { source: "policy.md" }
});

const embedded = await embedRetrievalDocuments({
  model: embeddingModel,
  documents: chunks
});

await vectorStore.upsert(embedded);

const retrieved = await retrieveContext({
  retriever,
  query: userQuestion,
  topK: 4
});

const result = await runAgent(agent, {
  userId,
  messages: [
    createRetrievalContextMessage(retrieved),
    { role: "user", parts: [{ type: "text", text: userQuestion }] }
  ]
});
```

## App-Owned Stores

`VectorStore` is intentionally only an interface:

```ts
const vectorStore = {
  async upsert(documents) {
    await appDb.saveEmbeddings(documents);
  },
  async query({ embedding, topK, metadata }) {
    return appDb.searchEmbeddings({ embedding, topK, metadata });
  }
};
```

For Postgres or pgvector, keep the SQL schema and driver in your app and implement `upsert()` / `query()` there. For Supabase, use your existing Supabase client from app code and keep row-level security, workspace filters, and service-role secrets outside the SDK. Core does not import `pg`, Supabase, pgvector clients, or any vector database package.

For local prototypes, you can keep documents in memory and use `rankRetrievedDocuments()` with `cosineSimilarity()`.

## Memory Boundaries

`AgentMemoryStore` is short-term conversation memory. It loads compact `ModelMessage[]` context into fresh agent runs and can persist that context in memory, files, SQLite, or Postgres.

RAG memory is long-term semantic memory. It stores embedded documents outside the agent state and retrieves relevant context for a user question. Use `RetrievalDocument`, `EmbeddedRetrievalDocument`, `RetrievedDocument`, `Retriever`, and `VectorStore` for this layer.

Do not use semantic/RAG memory as a hidden global prompt. Retrieve explicitly per request, apply tenant/workspace filters in your app-owned retriever, and inject only the redacted context the model needs.

## Runnable Example

`examples/sdk/rag-agent.ts` is deterministic and does not require provider credentials. It uses an in-file vector store, a deterministic embedding model, `retrieveContext()`, and `createRetrievalContextMessage()` to run a simple RAG-backed agent.
