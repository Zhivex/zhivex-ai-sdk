import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createVertex } from "../packages/vertex/src/index.js";
import { vertexIntegrationCredentials } from "../packages/core/tests/vertex-integration-profile.js";
const credentials = vertexIntegrationCredentials(process.env, true);
if (!credentials.configured) throw new Error(credentials.requirement);
try {
  const result = await createVertex({ ...credentials.options, location: "us-central1" }).multimodalEmbeddings.embed({
    text: "An invoice and a road with vehicles.",
    image: { data: await readFile(new URL("../packages/vertex/tests/fixtures/ocr-invoice.png", import.meta.url)), mediaType: "image/png" },
    video: { uri: "gs://cloud-samples-data/vertex-ai-vision/highway_vehicles.mp4", mediaType: "video/mp4" },
    videoSegmentConfig: { startOffsetSec: 0, endOffsetSec: 4, intervalSec: 4 },
    timeoutMs: 45_000, maxRetries: 0
  });
  assert.equal(result.textEmbedding?.length, 1408);
  assert.equal(result.imageEmbedding?.length, 1408);
  assert.equal(result.videoEmbeddings?.length, 1);
  const segment = result.videoEmbeddings![0]!;
  assert.equal(segment.startOffsetSec, 0);
  assert.equal(segment.endOffsetSec, 4);
  assert.equal(segment.embedding.length, 1408);
  console.log(JSON.stringify({ ok: true, textDimensions: result.textEmbedding.length, imageDimensions: result.imageEmbedding.length,
    videoSegments: 1, videoDimensions: segment.embedding.length, startOffsetSec: segment.startOffsetSec, endOffsetSec: segment.endOffsetSec }));
} catch (error) {
  if (process.env.VERTEX_LIVE_DIAGNOSTICS === "1") console.error(JSON.stringify((error as { responseBody?: unknown }).responseBody));
  console.log(JSON.stringify({ ok: false, error: (error as Error).name, status: (error as { status?: number }).status }));
  process.exitCode = 1;
}
