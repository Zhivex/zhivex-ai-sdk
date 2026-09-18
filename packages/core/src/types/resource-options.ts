import type {
  ProviderOptions
} from "./common.js";
import type {
  BatchCancelInput,
  BatchCreateInput,
  BatchDeleteInput,
  BatchGetInput,
  BatchListInput,
  ContextCacheCreateInput,
  ContextCacheDeleteInput,
  ContextCacheGetInput,
  ContextCacheListInput,
  FileDeleteInput,
  FileGetInput,
  FileListInput,
  FileSearchStoreCreateInput,
  FileSearchStoreDeleteInput,
  FileSearchStoreGetInput,
  FileSearchStoreImportInput,
  FileSearchStoreListInput,
  FileSearchStoreUploadInput,
  FileUploadInput,
  InteractionCancelInput,
  InteractionCreateInput,
  InteractionDeleteInput,
  InteractionGetInput,
  InteractionResumeInput,
  PredictionModel,
  PredictionModelInput,
  PredictionOperationInput
} from "./provider-resources.js";
import type {
  ProviderAdapter
} from "./provider.js";

export type UploadFileOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  FileUploadInput & {
    provider: TProvider;
  };

export type GetFileOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  FileGetInput & {
    provider: TProvider;
  };

export type ListFilesOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  FileListInput & {
    provider: TProvider;
  };

export type DeleteFileOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  FileDeleteInput & {
    provider: TProvider;
  };

export type CreateFileSearchStoreOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  FileSearchStoreCreateInput & {
    provider: TProvider;
  };

export type UploadToFileSearchStoreOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  FileSearchStoreUploadInput & {
    provider: TProvider;
  };

export type ImportFileToFileSearchStoreOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  FileSearchStoreImportInput & {
    provider: TProvider;
  };

export type GetFileSearchStoreOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  FileSearchStoreGetInput & {
    provider: TProvider;
  };

export type ListFileSearchStoresOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  FileSearchStoreListInput & {
    provider: TProvider;
  };

export type DeleteFileSearchStoreOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  FileSearchStoreDeleteInput & {
    provider: TProvider;
  };

export type CreateContextCacheOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  ContextCacheCreateInput & {
    provider: TProvider;
  };

export type GetContextCacheOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  ContextCacheGetInput & {
    provider: TProvider;
  };

export type ListContextCachesOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  ContextCacheListInput & {
    provider: TProvider;
  };

export type DeleteContextCacheOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  ContextCacheDeleteInput & {
    provider: TProvider;
  };

export type CreateBatchOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  BatchCreateInput & {
    provider: TProvider;
  };

export type GetBatchOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  BatchGetInput & {
    provider: TProvider;
  };

export type ListBatchesOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  BatchListInput & {
    provider: TProvider;
  };

export type CancelBatchOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  BatchCancelInput & {
    provider: TProvider;
  };

export type DeleteBatchOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  BatchDeleteInput & {
    provider: TProvider;
  };

export type CreateInteractionOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  InteractionCreateInput & {
    provider: TProvider;
  };

export type GetInteractionOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  InteractionGetInput & {
    provider: TProvider;
  };

export type CancelInteractionOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  InteractionCancelInput & {
    provider: TProvider;
  };

export type DeleteInteractionOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  InteractionDeleteInput & {
    provider: TProvider;
  };

export type ResumeInteractionOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  InteractionResumeInput & {
    provider: TProvider;
  };

export type StreamInteractionOptions<TProvider extends ProviderAdapter = ProviderAdapter> =
  InteractionCreateInput & {
    provider: TProvider;
  };

export type PredictRawOptions<TModel extends PredictionModel = PredictionModel> =
  PredictionModelInput<TModel extends PredictionModel<infer TProviderOptions> ? TProviderOptions : ProviderOptions> & {
    model: TModel;
  };

export type PredictLongRunningOptions<TModel extends PredictionModel = PredictionModel> =
  PredictionModelInput<TModel extends PredictionModel<infer TProviderOptions> ? TProviderOptions : ProviderOptions> & {
    model: TModel;
  };

export type FetchPredictionOperationOptions<TModel extends PredictionModel = PredictionModel> =
  PredictionOperationInput<TModel extends PredictionModel<infer TProviderOptions> ? TProviderOptions : ProviderOptions> & {
    model: TModel;
  };
