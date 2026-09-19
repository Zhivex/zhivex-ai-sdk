import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { createVertex } from "../packages/vertex/src/index.js";
import { vertexIntegrationCredentials } from "../packages/core/tests/vertex-integration-profile.js";
const statePath = process.argv[2];
if (!statePath) throw new Error("Pass the cache smoke state file");
const match = /^vertex-cache-([0-9a-f-]{36})\.json$/.exec(basename(statePath));
if (!match) throw new Error("Expected a cache smoke state filename");
const state = JSON.parse(await readFile(statePath, "utf8"));
const credentials = vertexIntegrationCredentials(process.env, true);
if (!credentials.configured) throw new Error(credentials.requirement);
const provider = createVertex({ ...credentials.options, location: "us-central1" });
const displayName = `zhivex-smoke-${match[1]}`;
let pageToken: string | undefined;
let removed = 0;
for (let page = 0; page < 20; page++) {
  const result = await provider.caches!.list({ pageSize: 100, pageToken, timeoutMs: 20_000, maxRetries: 0 });
  for (const cache of result.caches) {
    if (cache.displayName !== displayName) continue;
    await provider.caches!.delete({ name: cache.name, timeoutMs: 15_000, maxRetries: 0 });
    removed++;
  }
  pageToken = result.nextPageToken;
  if (!pageToken) break;
}
if (pageToken) throw new Error("Incomplete cache enumeration; state remains unresolved");
await writeFile(statePath, JSON.stringify({ ...state, displayName, reconciled: true, removed, absentAfterCompleteEnumeration: removed === 0 }), { mode: 0o600 });
console.log(JSON.stringify({ reconciled: true, removed, absentAfterCompleteEnumeration: removed === 0 }));
