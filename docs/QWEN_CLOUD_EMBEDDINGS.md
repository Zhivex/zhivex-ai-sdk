# Qwen Cloud text embeddings

`embeddingModel()` retains the shared dense-vector interface. `textEmbeddingModel()` additionally exposes provider-native dense, sparse and hybrid results.

```ts
import { createQwen, QWEN_CLOUD_BASE_URL } from "@zhivex-ai/qwen";
const qwen = createQwen({ apiKey: process.env.QWEN_API_KEY, baseURL: QWEN_CLOUD_BASE_URL });
const model = qwen.textEmbeddingModel("qwen3.7-text-embedding");

const dense = await model.embed({
  values: ["Customer needs a refund"],
  providerOptions: { dimensions: 256 }
});
const hybrid = await model.embedNative({
  values: ["refund policy"],
  providerOptions: {
    dimensions: 256,
    text_type: "query",
    instruct: "Retrieve the relevant policy document",
    output_type: "dense&sparse"
  }
});
console.log(dense.embeddings[0]);
console.log(hybrid.entries[0]?.embedding, hybrid.entries[0]?.sparseEmbedding);
```

Simple dense requests use the compatible `/embeddings` endpoint. Native options select the DashScope text-embedding endpoint. `embedNative()` returns ordered entries with `index`, optional dense `embedding`, and optional `sparseEmbedding`. Each sparse item has a token-space `index`, numeric `value`, and optional `token` string. Sparse indexes are not dense-vector positions or input indexes.

Use `output_type: "sparse"` only with `embedNative()`. The shared `embed()` interface requires dense arrays; hybrid output retains its sparse component in the provider JSON included in `rawResponse`. Input and result indexes are checked, out-of-order results are restored, and duplicate indexes, invalid vectors, inconsistent dimensions, malformed sparse entries and invalid token usage are rejected.

The 3.7 model supports dimensions 256, 512, 768, 1024, 1536, 2048 and 2560, with at most 20 text inputs per request. The adapter validates documented dimensions and batch sizes for v3/v4 too. It cannot determine the model's exact token budget locally; the service validates token limits. Query instructions require `text_type: "query"` and are not enabled for v3. [Official embedding guide](https://docs.qwencloud.com/developer-guides/embeddings/embedding).

## Verification

September 26, 2026: a short authenticated `qwen3.7-text-embedding` request returned a valid 256-dimensional dense vector. A separate tiny native query with an instruction and `output_type: "dense&sparse"` also passed: the response contained a 256-dimensional dense vector and nonempty sparse entries. Other allowed dimensions remain contract-validated rather than independently live-tested. Eight focused contract tests cover option mapping, input ordering, retries, batch validation and malformed provider output. The follow-up native verification used one short query with zero retries.

The text-model review also added a 27B image-plus-video request test, audio/document rejection, character web-search handling, and unsupported `search_strategy: "agent"` rejection for open models. Hosted-tool availability must follow each dedicated tool's model matrix, since broad model summaries can omit supported models. [Official web-search guide](https://docs.qwencloud.com/developer-guides/tool-calling/web-search).

The separate temporary-key smoke also passed on September 26: `temporaryKeys.create({ expiresInSeconds: 60 })` returned an `st-` token and a valid near-future expiration. Validation inspected only booleans and expiration metadata; no token was printed or persisted. This verifies token issuance, not browser playback or every token-authorized API. The API returns an opaque token that may include `+`, `/` or `=`; consumers must not assume a base64url-only alphabet. To repeat only this non-inference check, select `-t 'short-lived key metadata'` in `cloud-text.integration.test.ts` with the integration Vitest configuration.
