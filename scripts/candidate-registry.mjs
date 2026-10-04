import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

/** A loopback-only registry for one immutable packed batch, without upstream fallbacks. */
export async function startCandidateRegistry(packed) {
  const candidates = new Map();
  const tarballs = new Map();
  for (const { manifest, tarball, integrity } of packed) {
    assert.ok(manifest.name.startsWith("@zhivex-ai/"), "Candidate registry is limited to @zhivex-ai");
    assert.ok(!candidates.has(manifest.name), `Duplicate candidate: ${manifest.name}`);
    const bytes = readFileSync(tarball);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), integrity, `Candidate tarball changed: ${manifest.name}`);
    const endpoint = `/tarballs/${candidates.size}.tgz`;
    tarballs.set(endpoint, bytes);
    candidates.set(manifest.name, { manifest, endpoint, bytes });
  }
  let url;
  const server = createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, "http://fixture").pathname); }
    catch { response.writeHead(400).end(); return; }
    const bytes = tarballs.get(pathname);
    if (bytes) {
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length });
      response.end(request.method === "HEAD" ? undefined : bytes);
      return;
    }
    const candidate = candidates.get(pathname.slice(1));
    if (!candidate) { response.writeHead(404, { "content-type": "application/json" }).end('{"error":"Candidate not found"}'); return; }
    const { manifest, endpoint, bytes: artifact } = candidate;
    const version = { ...manifest, dist: {
      tarball: url + endpoint,
      shasum: createHash("sha1").update(artifact).digest("hex"),
      integrity: `sha512-${createHash("sha512").update(artifact).digest("base64")}`
    } };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(request.method === "HEAD" ? undefined : JSON.stringify({ name: manifest.name, "dist-tags": { latest: manifest.version }, versions: { [manifest.version]: version } }));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  url = `http://127.0.0.1:${server.address().port}`;
  return { url, close: async () => { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
