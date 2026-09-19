import {
  ConfigurationError, ProviderHTTPError, UnsupportedFeatureError,
  createChatCompletionsModel, encodeMediaFrame, readErrorBodyWithLimit, readJsonWithLimit,
  withRetry, withTimeoutSignal,
  type DocumentExtractionInput, type DocumentExtractionPage, type DocumentExtractionResult,
  type TextCompletionInput, type GenerateResult, type StreamEvent
} from "@zhivex-ai/core/provider";
import { createVertexChatModel } from "./chat.js";

export interface VertexOCRClient {
  process(input: DocumentExtractionInput): Promise<DocumentExtractionResult>;
}
export interface VertexFIMClient {
  generate(input: TextCompletionInput): Promise<GenerateResult>;
  stream(input: TextCompletionInput): Promise<AsyncIterable<StreamEvent>>;
}
export interface VertexSpecializedClients {
  ocr: VertexOCRClient;
  fim: VertexFIMClient;
}

const mistralModel = (value: string, family: "mistral-ocr-" | "codestral") => {
  const model = value.replace(/^mistralai\//, "");
  if (!model.startsWith(family) || /[\\/?#\s]/.test(model)) throw new ConfigurationError(`Vertex requires a ${family} model ID for this API.`);
  return model;
};

const assertNativeOptions = (options: Record<string, unknown> | undefined, reserved: string[], surface: string) => {
  for (const key of reserved) if (options?.[key] !== undefined) throw new ConfigurationError(`Vertex ${surface} providerOptions.${key} conflicts with its dedicated input contract.`);
};

export const createVertexSpecializedClients = (baseURL: string, fetcher: typeof globalThis.fetch, assertAccess: () => void): VertexSpecializedClients => {
  const url = (model: string, stream = false) => `${baseURL}/publishers/mistralai/models/${encodeURIComponent(model)}:${stream ? "streamRawPredict" : "rawPredict"}`;
  const completion = (input: TextCompletionInput) => {
    assertAccess();
    const modelId = mistralModel(input.modelId, "codestral");
    assertNativeOptions(input.providerOptions, ["model", "prompt", "suffix", "stream", "messages", "tools", "tool_choice", "response_format", "max_tokens", "temperature", "top_p", "stop"], "FIM");
    if (typeof input.prompt !== "string" || (input.suffix !== undefined && typeof input.suffix !== "string")) throw new ConfigurationError("Vertex FIM requires a text prompt and optional text suffix.");
    if (input.maxTokens !== undefined && (!Number.isInteger(input.maxTokens) || input.maxTokens <= 0)) throw new ConfigurationError("Vertex FIM maxTokens must be a positive integer.");
    if (input.temperature !== undefined && (!Number.isFinite(input.temperature) || input.temperature < 0)) throw new ConfigurationError("Vertex FIM temperature must be finite and nonnegative.");
    if (input.topP !== undefined && (!Number.isFinite(input.topP) || input.topP <= 0 || input.topP > 1)) throw new ConfigurationError("Vertex FIM topP must be greater than zero and at most one.");
    if (input.stop !== undefined && (typeof input.stop !== "string" && (!Array.isArray(input.stop) || input.stop.some((value) => typeof value !== "string")))) throw new ConfigurationError("Vertex FIM stop must be text or an array of text values.");
    return createChatCompletionsModel({ provider: "vertex", modelId,
      capabilities: { streaming: true, tools: false, structuredOutput: false, jsonMode: false, toolChoice: false, parallelToolCalls: false, vision: false, files: false, audioInput: false, audioOutput: false, embeddings: false, reasoning: false, webSearch: false },
      send: (body, signal) => fetcher(url(modelId, body.stream === true), {
        method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal,
        body: JSON.stringify({ ...input.providerOptions, model: modelId.split("@")[0], prompt: input.prompt,
          ...(input.suffix !== undefined ? { suffix: input.suffix } : {}),
          ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
          ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
          ...(input.topP !== undefined ? { top_p: input.topP } : {}),
          ...(input.stop !== undefined ? { stop: input.stop } : {}), stream: body.stream })
      })
    });
  };
  return {
    fim: {
      generate: (input) => completion(input).generate({ ...input, messages: [] }),
      stream: (input) => completion(input).stream!({ ...input, messages: [] })
    },
    ocr: {
      async process(input) {
        assertAccess();
        assertNativeOptions(input.providerOptions, ["model", "document", "pages", "include_image_base64", "stream", "messages"], "OCR");
        const media = input.document;
        if (!media || (media.uri === undefined) === (media.data === undefined)) throw new ConfigurationError("Vertex OCR requires exactly one document uri or data value.");
        const image = /^image\/(?:png|jpeg|webp|gif)$/.test(media.mediaType);
        if (!image && media.mediaType !== "application/pdf") throw new UnsupportedFeatureError("Vertex Mistral OCR accepts PDF or image input.");
        if (input.pages?.some((page) => !Number.isInteger(page) || page < 0)) throw new ConfigurationError("OCR pages must contain nonnegative integer indices.");
        if (input.includeImages !== undefined && typeof input.includeImages !== "boolean") throw new ConfigurationError("OCR includeImages must be a boolean.");
        if (media.uri !== undefined && !/^https?:\/\//.test(media.uri)) throw new ConfigurationError("Vertex OCR document URLs must use HTTP(S); use inline data for local files.");
        const source = media.uri ?? `data:${media.mediaType};base64,${encodeMediaFrame({ data: media.data!, mediaType: media.mediaType })}`;
        if (["deepseek-ai/deepseek-ocr-maas", "publishers/deepseek-ai/models/deepseek-ocr-maas"].includes(input.modelId)) {
          if (!image) throw new UnsupportedFeatureError("Vertex DeepSeek OCR requires one image; rasterize PDF pages before extraction.");
          if (input.pages !== undefined || input.includeImages !== undefined) throw new UnsupportedFeatureError("Vertex DeepSeek OCR does not expose page selection or extracted images.");
          if (input.prompt !== undefined && (typeof input.prompt !== "string" || !input.prompt.trim())) throw new ConfigurationError("Vertex DeepSeek OCR prompt must be nonempty text.");
          assertNativeOptions(input.providerOptions, ["prompt", "tools", "tool_choice", "response_format"], "DeepSeek OCR");
          const result = await createVertexChatModel("deepseek-ai/deepseek-ocr-maas", baseURL, fetcher).generate({
            ...input,
            messages: [{ role: "user", parts: [{ type: "text", text: input.prompt ?? "Free OCR" }, { type: "image", image: source }] }]
          });
          if (result.finishReason !== "stop") throw new ConfigurationError(`Vertex DeepSeek OCR did not complete extraction (${result.finishReason ?? "unknown"}).`);
          if (typeof result.text !== "string") throw new ConfigurationError("Vertex DeepSeek OCR returned no text.");
          // The input is one image, not a paginated document. Index zero identifies it.
          return { text: result.text, pages: [{ index: 0, markdown: result.text }], rawResponse: result.rawResponse };
        }
        const model = mistralModel(input.modelId, "mistral-ocr-");
        if (input.prompt !== undefined) throw new UnsupportedFeatureError("Vertex Mistral OCR does not expose a text extraction prompt.");
        const body = { ...input.providerOptions, model: model.split("@")[0],
          document: image ? { type: "image_url", image_url: source } : { type: "document_url", document_url: source },
          ...(input.pages ? { pages: input.pages } : {}), ...(input.includeImages !== undefined ? { include_image_base64: input.includeImages } : {}) };
        const { signal, cleanup } = withTimeoutSignal(input);
        try {
          const response = await withRetry(async () => {
            const result = await fetcher(url(model), { method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal, body: JSON.stringify(body) });
            if (!result.ok) throw new ProviderHTTPError(`Vertex OCR failed with status ${result.status}.`, result.status, { responseBody: await readErrorBodyWithLimit(result) });
            return result;
          }, { ...input, abortSignal: signal });
          const json: any = await readJsonWithLimit(response, { maxBytes: 128 * 1024 * 1024 });
          if (!Array.isArray(json.pages)) throw new ConfigurationError("Vertex OCR returned no pages array.");
          const indices = new Set<number>();
          const pages: DocumentExtractionPage[] = json.pages.map((page: any) => {
            if (!page || !Number.isInteger(page.index) || page.index < 0 || typeof page.markdown !== "string" || indices.has(page.index)) throw new ConfigurationError("Vertex OCR returned an invalid or duplicate page.");
            indices.add(page.index);
            return { index: page.index, markdown: page.markdown, ...(Array.isArray(page.images) ? { images: page.images } : {}), providerMetadata: page };
          });
          return { text: pages.map((page) => page.markdown).join("\n\n"), pages, rawResponse: json };
        } finally { cleanup(); }
      }
    }
  };
};
