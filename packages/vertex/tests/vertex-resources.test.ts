import { describe, expect, it, vi } from "vitest";
import { embedMany } from "@zhivex-ai/core";
import { createVertex } from "../src/index.js";

const setup = (location = "global") => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const provider = createVertex({ projectId: "test-project", accessToken: "test-token", location, fetch });
  return { provider, fetch };
};

describe("Vertex resource contracts", () => {
  it.each(["create", "delete"] as const)("honors explicit cache %s retries and the overall deadline", async operation => {
    const { provider, fetch } = setup("us-central1");
    const input = { name: "cachedContents/one", modelId: "gemini-2.5-flash", contents: [], maxRetries: 1, retryBackoffMs: 1 };
    fetch.mockResolvedValueOnce(new Response("busy", { status: 503 })).mockResolvedValueOnce(operation === "delete" ? new Response(null, { status: 204 }) : Response.json({ name: "cachedContents/one" }));
    expect((await provider.caches[operation](input)).name).toBe("cachedContents/one");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toBe(fetch.mock.calls[1]?.[0]);
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(fetch.mock.calls[1]?.[1]?.body);
    fetch.mockReset().mockImplementation(async () => new Response("busy", { status: 503 }));
    await expect(provider.caches[operation]({ ...input, timeoutMs: 10, retryBackoffMs: 1000 })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not interpret cache deletion 404 as a confirmed deletion", async () => {
    const { provider, fetch } = setup();
    fetch.mockResolvedValue(new Response("missing", { status: 404 }));
    await expect(provider.caches.delete({ name: "cachedContents/missing", maxRetries: 2 })).rejects.toMatchObject({ status: 404 });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("maps Gemini BigQuery input/output without silently replacing the selected source", async () => {
    const { provider, fetch } = setup("us-central1");
    fetch.mockResolvedValueOnce(Response.json({ name: "batchPredictionJobs/one" }));
    const outputConfig = { predictionsFormat: "bigquery", bigqueryDestination: { outputUri: "bq://project.dataset.output" } };
    await provider.batches!.create({ modelId: "gemini-2.5-flash", fileName: "bq://project.dataset.input", providerOptions: { outputConfig } });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      inputConfig: { instancesFormat: "bigquery", bigquerySource: { inputUri: "bq://project.dataset.input" } }, outputConfig
    });
    fetch.mockClear();
    for (const fileName of ["bq://project.dataset", "bq://project..table", "bq://project.dataset.table/extra", "bq://project.data set.table"]) {
      await expect(provider.batches!.create({ modelId: "gemini-2.5-flash", fileName, providerOptions: { outputConfig } })).rejects.toThrow("project.dataset.table");
    }
    await expect(provider.batches!.create({ modelId: "gemini-2.5-flash", fileName: "bq://project.dataset.input", providerOptions: { outputConfig, inputConfig: { instancesFormat: "jsonl", gcsSource: { uris: ["gs://other/input"] } } } })).rejects.toThrow("not both");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses prediction action only for routing and preserves an explicit raw body", async () => {
    const { provider, fetch } = setup();
    fetch.mockImplementation(async () => Response.json({ predictions: [] }));
    const model = provider.predictionModel!("endpoints/deployed");
    await model.predictRaw({ instances: ["input"], providerOptions: { action: "rawPredict", custom: true } });
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(/:rawPredict$/);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ instances: ["input"], custom: true });
    await model.predictRaw({ body: { action: "model-native-field" }, providerOptions: { action: "rawPredict" } });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ action: "model-native-field" });
  });

  it("rejects conflicting prediction inputs and operation identity overrides before fetching", async () => {
    const { provider, fetch } = setup();
    const model = provider.predictionModel!("endpoints/deployed");
    await expect(model.predictRaw({ instances: ["declared"], providerOptions: { instances: ["override"] } })).rejects.toThrow("conflicts");
    await expect(model.predictRaw({ parameters: { a: 1 }, providerOptions: { parameters: { a: 2 } } })).rejects.toThrow("conflicts");
    for (const key of ["operationName", "operation_name"]) {
      await expect(model.fetchPredictionOperation!({ name: "operations/declared", providerOptions: { [key]: "operations/override" } })).rejects.toThrow("through name");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["predictRaw", "rawPredict", "invoke", "predictLongRunning", "fetchPredictionOperation"] as const)("retries native %s HTTP errors and bounds backoff", async operation => {
    const { provider, fetch } = setup("us-central1");
    const model = provider.predictionModel!("endpoints/deployed");
    const input = { name: "operations/one", body: { inputs: "synthetic" }, maxRetries: 1, retryBackoffMs: 1 };
    fetch.mockResolvedValueOnce(new Response("busy", { status: 503 })).mockResolvedValueOnce(Response.json({ name: "operations/one", done: true, predictions: ["ok"] }));
    await model[operation]!(input);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toBe(fetch.mock.calls[1]?.[0]);
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(fetch.mock.calls[1]?.[1]?.body);
    fetch.mockReset().mockImplementation(async () => new Response("busy", { status: 503 }));
    await expect(model[operation]!({ ...input, timeoutMs: 10, retryBackoffMs: 1000 })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
    fetch.mockReset().mockImplementation(async () => new Response("invalid", { status: 400 }));
    await expect(model[operation]!(input)).rejects.toMatchObject({ status: 400 });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("routes publisher-qualified batch selectors and retries transient HTTP errors", async () => {
    const { provider, fetch } = setup("us-central1");
    fetch.mockResolvedValueOnce(Response.json({ error: { message: "temporary" } }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ name: "batchPredictionJobs/job", state: "JOB_STATE_PENDING" }));
    await provider.batches!.create({ modelId: "openai/gpt-oss-120b-maas", fileName: "gs://bucket/input.jsonl", maxRetries: 1, retryBackoffMs: 0,
      providerOptions: { outputConfig: { predictionsFormat: "jsonl", gcsDestination: { outputUriPrefix: "gs://bucket/output/" } } } });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[1][1]!.body as string).model).toBe("publishers/openai/models/gpt-oss-120b-maas");
    fetch.mockReset().mockResolvedValue(Response.json({ error: { message: "invalid" } }, { status: 400 }));
    await expect(provider.batches!.get({ name: "batchPredictionJobs/job", maxRetries: 1, retryBackoffMs: 0 })).rejects.toMatchObject({ status: 400 });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(["us", "eu"])("uses the %s jurisdictional endpoint", async (location) => {
    const { provider, fetch } = setup(location);
    fetch.mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }));
    await provider("gemini-3.8-flash").generate({ messages: [{ role: "user", parts: [{ type: "text", text: "Hi" }] }] });
    expect(String(fetch.mock.calls[0][0])).toBe(`https://aiplatform.${location}.rep.googleapis.com/v1/projects/test-project/locations/${location}/publishers/google/models/gemini-3.8-flash:generateContent`);
  });

  it("embeds text and media with embedContent in input order", async () => {
    const { provider, fetch } = setup();
    fetch.mockResolvedValueOnce(Response.json({ embedding: { values: [1, 2] } }))
      .mockResolvedValueOnce(Response.json({ embedding: { values: [3, 4] } }));
    const result = await embedMany({ model: provider.embeddingModel("gemini-embedding-2"), value: ["hello", { uri: "gs://bucket/image.png", mediaType: "image/png" }] });
    expect(result.embeddings).toEqual([[1, 2], [3, 4]]);
    expect(String(fetch.mock.calls[0][0])).toContain("gemini-embedding-2:embedContent");
    expect(JSON.parse(fetch.mock.calls[1][1]!.body as string)).toEqual({ content: { parts: [{ fileData: { fileUri: "gs://bucket/image.png", mimeType: "image/png" } }] } });
  });

  it("creates and lists native batchPredictionJobs", async () => {
    const { provider, fetch } = setup("us-central1");
    const name = "projects/test-project/locations/us-central1/batchPredictionJobs/123";
    fetch.mockResolvedValueOnce(Response.json({ name, state: "JOB_STATE_PENDING" }))
      .mockResolvedValueOnce(Response.json({ batchPredictionJobs: [{ name, state: "JOB_STATE_SUCCEEDED" }] }));
    await provider.batches!.create({ modelId: "gemini-2.5-flash", displayName: "test", fileName: "gs://bucket/input.jsonl", providerOptions: { outputConfig: { predictionsFormat: "jsonl", gcsDestination: { outputUriPrefix: "gs://bucket/output/" } } } });
    expect(String(fetch.mock.calls[0][0])).toMatch(/\/locations\/us-central1\/batchPredictionJobs$/);
    const body = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    expect(body.model).toBe("publishers/google/models/gemini-2.5-flash");
    expect(body.inputConfig).toEqual({ instancesFormat: "jsonl", gcsSource: { uris: ["gs://bucket/input.jsonl"] } });
    const jobs = await provider.batches!.list();
    expect(jobs.batches[0]).toMatchObject({ name, done: true });
  });

  it("resolves full job names without duplicating the project prefix", async () => {
    const { provider, fetch } = setup("us-central1");
    const name = "projects/test-project/locations/us-central1/batchPredictionJobs/123";
    fetch.mockResolvedValue(Response.json({ name, state: "JOB_STATE_SUCCEEDED" }));
    await provider.batches!.get({ name });
    expect(String(fetch.mock.calls[0][0])).toBe(`https://us-central1-aiplatform.googleapis.com/v1/${name}`);
  });
  it("cancels asynchronously and deletes using the native methods", async () => {
    const { provider, fetch } = setup("us-central1");
    const name = "projects/test-project/locations/us-central1/batchPredictionJobs/123";
    fetch.mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({ name, state: "JOB_STATE_CANCELLING" }))
      .mockResolvedValueOnce(Response.json({ name: "operations/delete-1", done: false }));
    expect(await provider.batches!.cancel({ name })).toMatchObject({ state: "JOB_STATE_CANCELLING", done: false });
    expect(String(fetch.mock.calls[0][0])).toBe(`https://us-central1-aiplatform.googleapis.com/v1/${name}:cancel`);
    expect(fetch.mock.calls[1][1]?.method).toBe("GET");
    expect(await provider.batches!.delete({ name })).toMatchObject({ name, rawResponse: { done: false } });
    expect(fetch.mock.calls[2][1]?.method).toBe("DELETE");
  });

  it("rejects invalid batch inputs without a network call", async () => {
    const { provider, fetch } = setup();
    await expect(provider.batches!.create({ modelId: "gemini-2.5-flash", fileName: "files/123" })).rejects.toThrow("gs://");
    await expect(provider.batches!.create({ modelId: "gemini-2.5-flash", requests: [] })).rejects.toThrow("Cloud Storage");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects partner batches on the global endpoint before fetching", async () => {
    const { provider, fetch } = setup("global");
    for (const modelId of ["claude-sonnet-4-6", "anthropic/claude-sonnet-4-6", "publishers/anthropic/models/claude-sonnet-4-6", "projects/p/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-6", "openai/gpt-oss-120b-maas"]) {
      await expect(provider.batches!.create({ modelId, fileName: "gs://bucket/input.jsonl", providerOptions: {
        outputConfig: { predictionsFormat: "jsonl", gcsDestination: { outputUriPrefix: "gs://bucket/output/" } }
      } })).rejects.toThrow("regional");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the effective batch endpoint for the partner region guard", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json({ name: "batchPredictionJobs/one" }));
    const input = { modelId: "claude-sonnet-4-6", fileName: "gs://bucket/input.jsonl", providerOptions: {
      outputConfig: { predictionsFormat: "jsonl", gcsDestination: { outputUriPrefix: "gs://bucket/output/" } }
    } };
    const regional = createVertex({ projectId: "p", location: "global", accessToken: "token", fetch,
      baseURL: "https://us-east5-aiplatform.googleapis.com/v1/projects/p/locations/us-east5" });
    await regional.batches!.create(input);
    expect(fetch).toHaveBeenCalledOnce();
    fetch.mockClear();
    const global = createVertex({ projectId: "p", location: "us-east5", accessToken: "token", fetch,
      baseURL: "https://aiplatform.googleapis.com/v1/projects/p/locations/global" });
    await expect(global.batches!.create(input)).rejects.toThrow("regional");
    expect(fetch).not.toHaveBeenCalled();
    // The partner restriction does not prohibit Google's global batch route.
    await global.batches!.create({ ...input, modelId: "gemini-2.5-flash" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("supports BigQuery and Claude publisher batches", async () => {
    const { provider, fetch } = setup("us-east5");
    fetch.mockResolvedValue(Response.json({ name: "batchPredictionJobs/1" }));
    await provider.batches!.create({ modelId: "claude-sonnet-4-6", fileName: "bq://project.dataset.input", providerOptions: { outputConfig: { predictionsFormat: "bigquery", bigqueryDestination: { outputUri: "bq://project.dataset" } } } });
    const body = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    expect(body.model).toBe("publishers/anthropic/models/claude-sonnet-4-6");
    expect(body.inputConfig.bigquerySource.inputUri).toBe("bq://project.dataset.input");
  });

  it.each(["endpoints/123", "projects/test-project/locations/us-central1/endpoints/123"])("predicts through deployed endpoint %s", async (resource) => {
    const { provider, fetch } = setup("us-central1");
    fetch.mockResolvedValue(Response.json({ predictions: [{ score: 0.9 }] }));
    const result = await provider.predictionModel!(resource).predictRaw({ instances: [{ text: "hello" }] });
    expect(result.predictions).toEqual([{ score: 0.9 }]);
    expect(String(fetch.mock.calls[0][0])).toBe("https://us-central1-aiplatform.googleapis.com/v1/projects/test-project/locations/us-central1/endpoints/123:predict");
  });

  it("resolves and deletes full cache resource names", async () => {
    const { provider, fetch } = setup();
    const name = "projects/test-project/locations/global/cachedContents/123";
    fetch.mockResolvedValueOnce(Response.json({ name }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await provider.caches!.get({ name });
    expect(String(fetch.mock.calls[0][0])).toBe(`https://aiplatform.googleapis.com/v1/${name}`);
    expect(await provider.caches!.delete({ name })).toMatchObject({ name });
  });
});
