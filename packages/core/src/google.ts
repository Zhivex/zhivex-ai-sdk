import { UnsupportedFeatureError } from "./errors.js";
import { hostedTool } from "./messages.js";
import type {
  BatchJob,
  CancelBatchOptions,
  CancelInteractionOptions,
  CachedContent,
  CreateBatchOptions,
  CreateContextCacheOptions,
  CreateFileSearchStoreOptions,
  CreateInteractionOptions,
  DeleteBatchOptions,
  DeleteContextCacheOptions,
  DeleteFileOptions,
  DeleteFileSearchStoreOptions,
  DeleteInteractionOptions,
  FetchPredictionOperationOptions,
  FileSearchStore,
  GetBatchOptions,
  GetContextCacheOptions,
  GetFileOptions,
  GetFileSearchStoreOptions,
  GetInteractionOptions,
  Interaction,
  JsonValue,
  ListBatchesOptions,
  ListContextCachesOptions,
  ListFileSearchStoresOptions,
  ListFilesOptions,
  PredictLongRunningOptions,
  PredictRawOptions,
  PredictionOperation,
  PredictionResult,
  ProviderAdapter,
  ResumeInteractionOptions,
  StreamEvent,
  UploadFileOptions,
  UploadToFileSearchStoreOptions,
  UploadedFile,
  ImportFileToFileSearchStoreOptions
} from "./types.js";

const missingClient = (provider: ProviderAdapter, capability: string) =>
  new UnsupportedFeatureError(`Provider "${provider.name}" does not support ${capability}.`);

export const uploadFile = async (options: UploadFileOptions): Promise<UploadedFile> => {
  const { provider, ...input } = options;
  if (!provider.files) {
    throw missingClient(provider, "files");
  }
  return provider.files.upload(input);
};

export const getFile = async (options: GetFileOptions): Promise<UploadedFile> => {
  const { provider, ...input } = options;
  if (!provider.files) {
    throw missingClient(provider, "files");
  }
  return provider.files.get(input);
};

export const listFiles = async (options: ListFilesOptions): Promise<{ files: UploadedFile[]; nextPageToken?: string; rawResponse?: unknown }> => {
  const { provider, ...input } = options;
  if (!provider.files) {
    throw missingClient(provider, "files");
  }
  return provider.files.list(input);
};

export const deleteFile = async (options: DeleteFileOptions): Promise<{ name: string; rawResponse?: unknown }> => {
  const { provider, ...input } = options;
  if (!provider.files) {
    throw missingClient(provider, "files");
  }
  return provider.files.delete(input);
};

export const createFileSearchStore = async (options: CreateFileSearchStoreOptions): Promise<FileSearchStore> => {
  const { provider, ...input } = options;
  if (!provider.fileSearchStores) {
    throw missingClient(provider, "file search stores");
  }
  return provider.fileSearchStores.create(input);
};

export const uploadToFileSearchStore = async (options: UploadToFileSearchStoreOptions): Promise<PredictionOperation> => {
  const { provider, ...input } = options;
  if (!provider.fileSearchStores) {
    throw missingClient(provider, "file search stores");
  }
  return provider.fileSearchStores.upload(input);
};

export const importFileToFileSearchStore = async (options: ImportFileToFileSearchStoreOptions): Promise<PredictionOperation> => {
  const { provider, ...input } = options;
  if (!provider.fileSearchStores) {
    throw missingClient(provider, "file search stores");
  }
  return provider.fileSearchStores.importFile(input);
};

export const getFileSearchStore = async (options: GetFileSearchStoreOptions): Promise<FileSearchStore> => {
  const { provider, ...input } = options;
  if (!provider.fileSearchStores) {
    throw missingClient(provider, "file search stores");
  }
  return provider.fileSearchStores.get(input);
};

export const listFileSearchStores = async (
  options: ListFileSearchStoresOptions
): Promise<{ stores: FileSearchStore[]; nextPageToken?: string; rawResponse?: unknown }> => {
  const { provider, ...input } = options;
  if (!provider.fileSearchStores) {
    throw missingClient(provider, "file search stores");
  }
  return provider.fileSearchStores.list(input);
};

export const deleteFileSearchStore = async (options: DeleteFileSearchStoreOptions): Promise<{ name: string; rawResponse?: unknown }> => {
  const { provider, ...input } = options;
  if (!provider.fileSearchStores) {
    throw missingClient(provider, "file search stores");
  }
  return provider.fileSearchStores.delete(input);
};

export const createContextCache = async (options: CreateContextCacheOptions): Promise<CachedContent> => {
  const { provider, ...input } = options;
  if (!provider.caches) {
    throw missingClient(provider, "context caching");
  }
  return provider.caches.create(input);
};

export const getContextCache = async (options: GetContextCacheOptions): Promise<CachedContent> => {
  const { provider, ...input } = options;
  if (!provider.caches) {
    throw missingClient(provider, "context caching");
  }
  return provider.caches.get(input);
};

export const listContextCaches = async (
  options: ListContextCachesOptions
): Promise<{ caches: CachedContent[]; nextPageToken?: string; rawResponse?: unknown }> => {
  const { provider, ...input } = options;
  if (!provider.caches) {
    throw missingClient(provider, "context caching");
  }
  return provider.caches.list(input);
};

export const deleteContextCache = async (options: DeleteContextCacheOptions): Promise<{ name: string; rawResponse?: unknown }> => {
  const { provider, ...input } = options;
  if (!provider.caches) {
    throw missingClient(provider, "context caching");
  }
  return provider.caches.delete(input);
};

export const createBatch = async (options: CreateBatchOptions): Promise<BatchJob> => {
  const { provider, ...input } = options;
  if (!provider.batches) {
    throw missingClient(provider, "batch jobs");
  }
  return provider.batches.create(input);
};

export const getBatch = async (options: GetBatchOptions): Promise<BatchJob> => {
  const { provider, ...input } = options;
  if (!provider.batches) {
    throw missingClient(provider, "batch jobs");
  }
  return provider.batches.get(input);
};

export const listBatches = async (options: ListBatchesOptions): Promise<{ batches: BatchJob[]; nextPageToken?: string; rawResponse?: unknown }> => {
  const { provider, ...input } = options;
  if (!provider.batches) {
    throw missingClient(provider, "batch jobs");
  }
  return provider.batches.list(input);
};

export const cancelBatch = async (options: CancelBatchOptions): Promise<BatchJob> => {
  const { provider, ...input } = options;
  if (!provider.batches) {
    throw missingClient(provider, "batch jobs");
  }
  return provider.batches.cancel(input);
};

export const deleteBatch = async (options: DeleteBatchOptions): Promise<{ name: string; rawResponse?: unknown }> => {
  const { provider, ...input } = options;
  if (!provider.batches) {
    throw missingClient(provider, "batch jobs");
  }
  return provider.batches.delete(input);
};

export const createInteraction = async (options: CreateInteractionOptions): Promise<Interaction> => {
  const { provider, ...input } = options;
  if (!provider.interactions) {
    throw missingClient(provider, "interactions");
  }
  return provider.interactions.create(input);
};

export const getInteraction = async (options: GetInteractionOptions): Promise<Interaction> => {
  const { provider, ...input } = options;
  if (!provider.interactions) {
    throw missingClient(provider, "interactions");
  }
  return provider.interactions.get(input);
};

export const cancelInteraction = async (options: CancelInteractionOptions): Promise<Interaction> => {
  const { provider, ...input } = options;
  if (!provider.interactions) {
    throw missingClient(provider, "interactions");
  }
  return provider.interactions.cancel(input);
};

export const deleteInteraction = async (
  options: DeleteInteractionOptions
): Promise<{ id: string; rawResponse?: unknown }> => {
  const { provider, ...input } = options;
  if (!provider.interactions) {
    throw missingClient(provider, "interactions");
  }
  return provider.interactions.delete(input);
};

export const resumeInteraction = async (
  options: ResumeInteractionOptions
): Promise<AsyncIterable<StreamEvent>> => {
  const { provider, ...input } = options;
  if (!provider.interactions) {
    throw missingClient(provider, "interactions");
  }
  return provider.interactions.resume(input);
};

export const streamInteraction = async (options: CreateInteractionOptions): Promise<AsyncIterable<StreamEvent>> => {
  const { provider, ...input } = options;
  if (!provider.interactions) {
    throw missingClient(provider, "interactions");
  }
  return provider.interactions.stream(input);
};

export const predictRaw = async (options: PredictRawOptions): Promise<PredictionResult> => {
  const { model, ...input } = options;
  if (!model.capabilities.rawPrediction) {
    throw new UnsupportedFeatureError(`Model "${model.provider}/${model.modelId}" does not support raw prediction.`);
  }
  return model.predictRaw(input);
};

export const predictLongRunning = async (options: PredictLongRunningOptions): Promise<PredictionOperation> => {
  const { model, ...input } = options;
  if (!model.capabilities.rawPrediction) {
    throw new UnsupportedFeatureError(`Model "${model.provider}/${model.modelId}" does not support long-running prediction.`);
  }
  return model.predictLongRunning(input);
};

export const fetchPredictionOperation = async (options: FetchPredictionOperationOptions): Promise<PredictionOperation> => {
  const { model, ...input } = options;
  if (!model.capabilities.rawPrediction) {
    throw new UnsupportedFeatureError(`Model "${model.provider}/${model.modelId}" does not support prediction operations.`);
  }
  return model.fetchPredictionOperation(input);
};

export const googleSearchTool = () =>
  hostedTool({
    name: "google_search",
    type: "googleSearch",
    config: {},
    toolClass: "web-search"
  });

export const googleMapsTool = (config: {
  latitude?: number;
  longitude?: number;
  enableWidget?: boolean;
} = {}) =>
  hostedTool({
    name: "google_maps",
    type: "googleMaps",
    config: JSON.parse(JSON.stringify(config)) as JsonValue,
    toolClass: "web-search"
  });

export const googleUrlContextTool = () =>
  hostedTool({
    name: "google_url_context",
    type: "urlContext",
    config: {},
    toolClass: "web-extraction"
  });

export const googleFileSearchTool = (storeNames: string[]) =>
  hostedTool({
    name: "google_file_search",
    type: "fileSearch",
    config: {
      fileSearchStoreNames: storeNames
    },
    toolClass: "file-search"
  });

export const googleCodeExecutionTool = () =>
  hostedTool({
    name: "google_code_execution",
    type: "codeExecution",
    config: {},
    toolClass: "code-execution"
  });

export const googleComputerUseTool = (config: Record<string, unknown> = {}) =>
  hostedTool({
    name: "google_computer_use",
    type: "computerUse",
    config: JSON.parse(JSON.stringify(config)) as JsonValue,
    toolClass: "computer-use"
  });
