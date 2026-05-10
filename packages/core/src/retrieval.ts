import { embedMany } from "./embed.js";
import { ValidationError } from "./errors.js";
import { createTextMessage } from "./messages.js";
import type { EmbeddingModel, JsonValue, ModelMessage, RetryOptions } from "./types.js";

export interface RetrievalDocument {
  id: string;
  content: string;
  metadata?: Record<string, JsonValue>;
}

export interface EmbeddedRetrievalDocument extends RetrievalDocument {
  embedding: number[];
}

export interface RetrievedDocument extends RetrievalDocument {
  score?: number;
}

export interface RetrieveContextInput {
  query: string;
  topK?: number;
  metadata?: Record<string, JsonValue>;
}

export interface Retriever {
  retrieve(input: RetrieveContextInput): Promise<RetrievedDocument[]> | RetrievedDocument[];
}

export interface VectorStoreQueryInput {
  embedding: number[];
  topK?: number;
  metadata?: Record<string, JsonValue>;
}

export interface VectorStore {
  upsert(documents: EmbeddedRetrievalDocument[]): Promise<void> | void;
  query(input: VectorStoreQueryInput): Promise<RetrievedDocument[]> | RetrievedDocument[];
  delete?(ids: string | string[]): Promise<void> | void;
}

export interface ChunkTextOptions {
  maxChars?: number;
  overlapChars?: number;
  idPrefix?: string;
  metadata?: Record<string, JsonValue>;
}

export type EmbedRetrievalDocumentsInput = RetryOptions & {
  model: EmbeddingModel;
  documents: RetrievalDocument[];
};

export interface RankRetrievedDocumentsOptions {
  topK?: number;
  minScore?: number;
}

export interface FormatRetrievedContextOptions {
  title?: string;
  includeScores?: boolean;
  maxDocuments?: number;
  separator?: string;
}

const defaultChunkMaxChars = 1_200;
const defaultChunkOverlapChars = 120;

const cloneMetadata = (metadata: Record<string, JsonValue> | undefined): Record<string, JsonValue> | undefined =>
  metadata ? { ...metadata } : undefined;

const assertPositiveInteger = (name: string, value: number) => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`"${name}" must be a positive integer.`);
  }
};

const assertNonNegativeInteger = (name: string, value: number) => {
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError(`"${name}" must be a non-negative integer.`);
  }
};

const validateTopK = (topK: number | undefined) => {
  if (topK !== undefined) {
    assertPositiveInteger("topK", topK);
  }
};

export const chunkText = (text: string, options: ChunkTextOptions = {}): RetrievalDocument[] => {
  const maxChars = options.maxChars ?? defaultChunkMaxChars;
  const overlapChars = options.overlapChars ?? defaultChunkOverlapChars;
  const idPrefix = options.idPrefix ?? "chunk";

  assertPositiveInteger("maxChars", maxChars);
  assertNonNegativeInteger("overlapChars", overlapChars);
  if (overlapChars >= maxChars) {
    throw new ValidationError('"overlapChars" must be smaller than "maxChars".');
  }

  const content = text.trim();
  if (!content) {
    return [];
  }

  const chunks: RetrievalDocument[] = [];
  let start = 0;
  while (start < content.length) {
    const end = Math.min(start + maxChars, content.length);
    const chunkContent = content.slice(start, end).trim();
    if (chunkContent) {
      chunks.push({
        id: `${idPrefix}-${chunks.length + 1}`,
        content: chunkContent,
        metadata: cloneMetadata(options.metadata)
      });
    }
    if (end >= content.length) {
      break;
    }
    start = end - overlapChars;
  }

  return chunks;
};

export const embedRetrievalDocuments = async (
  input: EmbedRetrievalDocumentsInput
): Promise<EmbeddedRetrievalDocument[]> => {
  const output = await embedMany({
    model: input.model,
    value: input.documents.map((document) => document.content),
    abortSignal: input.abortSignal,
    timeoutMs: input.timeoutMs,
    maxRetries: input.maxRetries,
    retryBackoffMs: input.retryBackoffMs
  });

  if (output.embeddings.length !== input.documents.length) {
    throw new ValidationError("Embedding model returned a different number of embeddings than retrieval documents.");
  }

  return input.documents.map((document, index) => ({
    ...document,
    metadata: cloneMetadata(document.metadata),
    embedding: output.embeddings[index] ?? []
  }));
};

export const retrieveContext = async (input: RetrieveContextInput & { retriever: Retriever }): Promise<RetrievedDocument[]> => {
  validateTopK(input.topK);
  const documents = await input.retriever.retrieve({
    query: input.query,
    topK: input.topK,
    metadata: input.metadata
  });
  return input.topK === undefined ? documents : documents.slice(0, input.topK);
};

export const cosineSimilarity = (a: number[], b: number[]): number => {
  if (a.length !== b.length) {
    throw new ValidationError("Embedding vectors must have the same length.");
  }

  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    aNorm += left * left;
    bNorm += right * right;
  }

  return aNorm === 0 || bNorm === 0 ? 0 : dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
};

export const rankRetrievedDocuments = (
  queryEmbedding: number[],
  documents: EmbeddedRetrievalDocument[],
  options: RankRetrievedDocumentsOptions = {}
): RetrievedDocument[] => {
  validateTopK(options.topK);
  return documents
    .map((document) => ({
      id: document.id,
      content: document.content,
      metadata: cloneMetadata(document.metadata),
      score: cosineSimilarity(queryEmbedding, document.embedding)
    }))
    .filter((document) => options.minScore === undefined || (document.score ?? 0) >= options.minScore)
    .sort((first, second) => (second.score ?? 0) - (first.score ?? 0) || first.id.localeCompare(second.id))
    .slice(0, options.topK);
};

export const formatRetrievedContext = (
  documents: RetrievedDocument[],
  options: FormatRetrievedContextOptions = {}
): string => {
  const title = options.title ?? "Retrieved context";
  const includeScores = options.includeScores ?? true;
  const separator = options.separator ?? "\n\n";

  if (options.maxDocuments !== undefined) {
    assertNonNegativeInteger("maxDocuments", options.maxDocuments);
  }

  const limitedDocuments =
    options.maxDocuments === undefined
      ? documents
      : documents.slice(0, options.maxDocuments);

  const formattedDocuments = limitedDocuments.map((document, index) => {
    const score = includeScores && document.score !== undefined ? ` score=${document.score.toFixed(3)}` : "";
    return `[${index + 1}] ${document.id}${score}\n${document.content}`;
  });

  return [title, ...formattedDocuments].join(separator).trim();
};

export const createRetrievalContextMessage = (
  documents: RetrievedDocument[],
  options: FormatRetrievedContextOptions = {}
): ModelMessage => createTextMessage("system", formatRetrievedContext(documents, options));
