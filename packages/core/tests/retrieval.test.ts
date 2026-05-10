import { describe, expect, it } from "vitest";

import {
  chunkText,
  cosineSimilarity,
  createRetrievalContextMessage,
  embedRetrievalDocuments,
  formatRetrievedContext,
  rankRetrievedDocuments,
  retrieveContext,
  ValidationError,
  type EmbeddingModel,
  type Retriever
} from "../src/index.js";

const createEmbeddingModel = (overrides?: Partial<EmbeddingModel>): EmbeddingModel => ({
  provider: "test",
  modelId: "retrieval-embed",
  capabilities: {
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
  },
  async embed(input) {
    return {
      embeddings: input.values.map((value, index) => [value.length, index])
    };
  },
  ...overrides
});

describe("retrieval helpers", () => {
  it("chunks text with ids, overlap, and metadata", () => {
    const chunks = chunkText("abcdefghi", {
      maxChars: 4,
      overlapChars: 1,
      idPrefix: "doc",
      metadata: { source: "guide" }
    });

    expect(chunks).toEqual([
      { id: "doc-1", content: "abcd", metadata: { source: "guide" } },
      { id: "doc-2", content: "defg", metadata: { source: "guide" } },
      { id: "doc-3", content: "ghi", metadata: { source: "guide" } }
    ]);
    expect(chunkText("   ")).toEqual([]);
  });

  it("rejects invalid chunk and retrieval options", async () => {
    expect(() => chunkText("hello", { maxChars: 0 })).toThrow(ValidationError);
    expect(() => chunkText("hello", { maxChars: 4, overlapChars: 4 })).toThrow(ValidationError);
    expect(() => formatRetrievedContext([], { maxDocuments: -1 })).toThrow(ValidationError);
    await expect(
      retrieveContext({
        retriever: { retrieve: () => [] },
        query: "hello",
        topK: 0
      })
    ).rejects.toThrow(ValidationError);
  });

  it("embeds retrieval documents while preserving document fields", async () => {
    const embedded = await embedRetrievalDocuments({
      model: createEmbeddingModel(),
      documents: [
        { id: "a", content: "alpha", metadata: { kind: "letter" } },
        { id: "b", content: "beta" }
      ]
    });

    expect(embedded).toEqual([
      { id: "a", content: "alpha", metadata: { kind: "letter" }, embedding: [5, 0] },
      { id: "b", content: "beta", metadata: undefined, embedding: [4, 1] }
    ]);
  });

  it("fails when embedding count does not match document count", async () => {
    await expect(
      embedRetrievalDocuments({
        model: createEmbeddingModel({
          async embed() {
            return { embeddings: [[1, 2]] };
          }
        }),
        documents: [
          { id: "a", content: "alpha" },
          { id: "b", content: "beta" }
        ]
      })
    ).rejects.toThrow(ValidationError);
  });

  it("retrieves context and enforces topK after the retriever returns", async () => {
    const retriever: Retriever = {
      retrieve(input) {
        expect(input).toMatchObject({
          query: "Madrid museums",
          topK: 2,
          metadata: { tenant: "demo" }
        });
        return [
          { id: "a", content: "first", score: 0.9 },
          { id: "b", content: "second", score: 0.8 },
          { id: "c", content: "third", score: 0.7 }
        ];
      }
    };

    await expect(retrieveContext({ retriever, query: "Madrid museums", topK: 2, metadata: { tenant: "demo" } })).resolves.toEqual([
      { id: "a", content: "first", score: 0.9 },
      { id: "b", content: "second", score: 0.8 }
    ]);
  });

  it("ranks embedded documents by cosine similarity", () => {
    const ranked = rankRetrievedDocuments(
      [1, 0],
      [
        { id: "b", content: "north", embedding: [0, 1] },
        { id: "a", content: "east", embedding: [1, 0], metadata: { source: "map" } },
        { id: "c", content: "near-east", embedding: [0.5, 0] }
      ],
      { topK: 2, minScore: 0.5 }
    );

    expect(cosineSimilarity([1, 1], [1, 1])).toBeCloseTo(1);
    expect(ranked).toEqual([
      { id: "a", content: "east", metadata: { source: "map" }, score: 1 },
      { id: "c", content: "near-east", metadata: undefined, score: 1 }
    ]);
    expect(() => cosineSimilarity([1], [1, 2])).toThrow(ValidationError);
  });

  it("formats retrieved context and creates a system message", () => {
    const documents = [
      { id: "doc-1", content: "Madrid has many museums.", score: 0.91234 },
      { id: "doc-2", content: "Billing support is separate." }
    ];

    expect(formatRetrievedContext(documents, { title: "Context", maxDocuments: 1 })).toBe(
      "Context\n\n[1] doc-1 score=0.912\nMadrid has many museums."
    );

    expect(createRetrievalContextMessage(documents, { includeScores: false })).toEqual({
      role: "system",
      parts: [
        {
          type: "text",
          text: "Retrieved context\n\n[1] doc-1\nMadrid has many museums.\n\n[2] doc-2\nBilling support is separate."
        }
      ]
    });
  });
});
