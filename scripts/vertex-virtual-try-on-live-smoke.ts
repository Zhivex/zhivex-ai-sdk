import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVertex } from "../packages/vertex/src/index.js";
import { vertexIntegrationCredentials } from "../packages/core/tests/vertex-integration-profile.js";

// One bounded generation with the public input images used by Google's notebook:
// https://github.com/GoogleCloudPlatform/generative-ai/blob/main/vision/getting-started/virtual_try_on.ipynb
// No user photos, output bucket or persistent cloud resources. Do not log image bytes.
const credentials = vertexIntegrationCredentials(process.env, true);
if (!credentials.configured) throw new Error(credentials.requirement);
const inline = process.argv.includes("--inline");
const saveArtifacts = process.argv.includes("--save-artifacts");
if (process.argv.slice(2).some((arg) => !["--inline", "--save-artifacts"].includes(arg))) {
  throw new Error("Supported options: --inline, --save-artifacts");
}
assert.ok(!saveArtifacts || inline, "--save-artifacts requires --inline");
async function publicImage(name: "man-in-field.png" | "sweater.jpg") {
  // Fixed public fixtures, downloaded without the authenticated provider fetcher.
  const response = await fetch(`https://storage.googleapis.com/cloud-samples-data/generative-ai/image/${name}`, {
    signal: AbortSignal.timeout(20_000), redirect: "error"
  });
  assert.ok(response.ok && response.body, "Public image download failed");
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    assert.ok(length <= 7 * 1024 * 1024, "Public image exceeds the fixture size limit");
    chunks.push(chunk);
  }
  assert.ok(length > 0, "Empty public image");
  return Buffer.concat(chunks);
}
try {
  const person = inline ? await publicImage("man-in-field.png") : undefined;
  const product = inline ? await publicImage("sweater.jpg") : undefined;
  const result = await createVertex({ ...credentials.options, location: "us-central1" }).virtualTryOn.generate({
    personImage: { ...(person ? { data: person } : { uri: "gs://cloud-samples-data/generative-ai/image/man-in-field.png" }), mediaType: "image/png" },
    productImage: { ...(product ? { data: product } : { uri: "gs://cloud-samples-data/generative-ai/image/sweater.jpg" }), mediaType: "image/jpeg" },
    ...(inline ? { providerOptions: { outputOptions: { compressionQuality: 85 } } } : {}),
    count: 1, outputMimeType: "image/jpeg", timeoutMs: 60_000, maxRetries: 0
  });
  assert.equal(result.filtered.length, 0);
  assert.equal(result.images.length, 1);
  const output = result.images[0];
  assert.equal(output.mediaType, "image/jpeg");
  assert.ok(output.data && output.data.length > 100);
  assert.deepEqual([...output.data.slice(0, 3)], [255,216,255]);
  assert.deepEqual([...output.data.slice(-2)], [255,217]);
  let artifactDirectory: string | undefined;
  if (saveArtifacts) {
    artifactDirectory = await mkdtemp(join(tmpdir(), "vertex-try-on-"));
    await writeFile(join(artifactDirectory, "person.png"), person!, { mode: 0o600 });
    await writeFile(join(artifactDirectory, "product.jpg"), product!, { mode: 0o600 });
    await writeFile(join(artifactDirectory, "result.jpg"), output.data, { mode: 0o600 });
  }
  console.log(JSON.stringify({ ok: true, model: "virtual-try-on-001", location: "us-central1", transport: inline ? "inline" : "gcs", bytes: output.data.length, mediaType: output.mediaType, artifactDirectory }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: (error as Error).name, status: (error as {status?:number}).status }));
  process.exitCode = 1;
}
