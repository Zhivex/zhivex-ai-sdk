import assert from "node:assert/strict";
import { createVertex } from "../packages/vertex/src/index.js";
import { vertexIntegrationCredentials } from "../packages/core/tests/vertex-integration-profile.js";

// Explicit invocation only. Public Google sample, one second, one bounded request.
// https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/embeddings/get-multimodal-embeddings
const credentials = vertexIntegrationCredentials(process.env, true);
if (!credentials.configured) throw new Error(credentials.requirement);
const inline = process.argv.includes("--inline");
const extractAudio = process.argv.includes("--extract-audio");
if (process.argv.slice(2).some((arg) => !["--inline", "--extract-audio"].includes(arg))) throw new Error("Supported options: --inline, --extract-audio");
try {
  // Fixed public sample only; never use the authenticated Vertex fetcher to download it.
  let video: { data: Uint8Array } | { uri: string } = {
    uri: extractAudio ? "gs://cloud-samples-data/generative-ai/video/pixel8.mp4" : "gs://cloud-samples-data/vertex-ai-vision/highway_vehicles.mp4"
  };
  if (inline) {
    const response = await fetch("https://storage.googleapis.com/cloud-samples-data/generative-ai/video/pixel8.mp4", {
      signal: AbortSignal.timeout(20_000), redirect: "error"
    });
    assert.ok(response.ok, "Public video download failed");
    const limit = 8 * 1024 * 1024;
    const chunks: Uint8Array[] = [];
    let length = 0;
    assert.ok(response.body, "Missing public video body");
    for await (const chunk of response.body) {
      length += chunk.byteLength;
      assert.ok(length <= limit, "Public video exceeds the fixture size limit");
      chunks.push(chunk);
    }
    assert.ok(length > 0, "Empty public video");
    video = { data: Buffer.concat(chunks) };
  }
  const result = await createVertex({ ...credentials.options, location: "us" })
    .embeddingModel("gemini-embedding-2").embed({
      values: [{ ...video, mediaType: "video/mp4",
        providerMetadata: { videoMetadata: { startOffset: "0s", endOffset: "1s", fps: 1 } } }],
      providerOptions: { outputDimensionality: 128, audioTrackExtraction: extractAudio },
      timeoutMs: 45_000, maxRetries: 0
    });
  assert.equal(result.embeddings.length, 1);
  const vector = result.embeddings[0]!;
  assert.equal(vector.length, 128);
  assert.ok(vector.every(Number.isFinite));
  const norm = Math.hypot(...vector);
  assert.ok(Math.abs(norm - 1) < 0.01, "Expected a normalized non-default-dimension embedding");
  assert.ok(Number.isSafeInteger(result.usage?.inputTokens) && result.usage!.inputTokens! > 0);
  console.log(JSON.stringify({ ok: true, transport: inline ? "inline" : "gcs", audioTrackExtraction: extractAudio, dimensions: vector.length, norm, inputTokens: result.usage?.inputTokens }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: (error as Error).name, status: (error as { status?: number }).status }));
  process.exitCode = 1;
}
