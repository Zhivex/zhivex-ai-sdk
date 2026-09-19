# Agent Live Certification Evidence

## 2026-09-19 recertification attempt

Status: **NOT CERTIFIED**. Source commit: `d1df46e67dff0882fb485c9f7054495749017d47` (only documentation edits during this run). Local package versions: Agents `1.8.0`, Core `1.19.0`. Runtime: Bun `1.4.0`, Node `22.21.0`; Bun is below the repository's requested `1.4.2`, so this is not release-environment certification.

Deterministic validation passed: 2,060 tests in 147 files, typecheck, documentation checks, clean build, and `smoke:packages` with 51 Node entrypoints plus `INSTALLED_REALTIME_LIVE_SMOKE_OK`. The first sandboxed test run could not listen on localhost; the unrestricted local run passed all tests.

The real database was a disposable `postgres:16-alpine` container, bound only to localhost, with data on tmpfs and no persistent volume.

| Provider/model | Approval/restart/journal | Streaming/persistence |
| --- | --- | --- |
| Gemini `gemini-3.7-flash` | FAIL: HTTP 429 | FAIL: HTTP 429 |
| DeepSeek `deepseek-v4-flash` | PASS | FAIL: expected certification token absent |
| Qwen `qwen3.7-plus` | PASS | PASS |

The independent real Postgres claims/CAS/leases/journal case passed. The full source gate finished with 4 passed and 3 failed. A bounded repeat with `ZHIVEX_AGENT_LIVE_PROVIDERS=deepseek,qwen` finished with 4 passed and 1 failed: DeepSeek streaming again did not contain `agent-deepseek-stream-ok`. Observed text was `agent-deep\n\ndeepseek-stream-ok` initially and `agent-deep#stream-ok` on repeat. The assertion was retained; this evidence alone does not establish whether the cause is upstream generation or stream handling.

`smoke:packages:agents-live` successfully packed and installed local tarballs, but stopped at its first provider, Gemini `gemini-3.6-flash`, with HTTP 429 / `RESOURCE_EXHAUSTED`: the account's prepayment credits were depleted. DeepSeek and Qwen were not reached by that installed live run. The installed script and source gate currently have different Gemini defaults; set `GEMINI_INTEGRATION_MODEL` explicitly to use the same model in both when repeating certification.

A direct `DeepSeekLanguageModel.stream()` probe, bypassing the agent runtime, also returned a mismatched token (`agent-deep全seek-stream-ok`). A final probe cloned the HTTP response and independently concatenated the SSE `choices[0].delta.content` fields: the raw content exactly matched the adapter's emitted text, including an unexpected `<ds_safety>` block inserted inside the token. That probe localizes the mismatch to content received from the upstream API, rather than text corruption by the adapter or agent runtime. No assertion was weakened and no provider-content filtering was added.

After all database tests, the temporary database had zero public tables. The disposable container was stopped and automatically removed.

Next certification requires restored Gemini billing, investigation of the DeepSeek streaming mismatch, the requested Bun version, and successful source/realtime/installed live gates on the intended release source. No npm publication or provenance was verified.

### Vertex credential follow-up (2026-09-19)

With `VERTEX_API_KEY` configured, the same source gate was run with `ZHIVEX_AGENT_LIVE_PROVIDERS=vertex`, using `gemini-3.7-flash` and a new disposable Postgres instance. Result: **1 passed, 2 failed**. The independent Postgres case passed; approval/restart returned HTTP 400 and streaming returned HTTP 403. A minimal direct generation diagnostic returned HTTP 403 / `PERMISSION_DENIED`, with reason `API_KEY_SERVICE_BLOCKED` for `aiplatform.googleapis.com` (`PredictionService.GenerateContent`). The key's allowed API restrictions must permit the Vertex service before this route can be certified. No key or credential value is recorded here.

This attempt does not certify Gemini direct, Vertex realtime, or installed Vertex tarballs. The database had zero public tables after cleanup; its temporary container was removed.

After the user updated the key permissions, the Vertex gate was repeated on the same source: **1 passed, 2 failed** (approval HTTP 400, streaming HTTP 403). A minimal direct generation request now reports `IAM_PERMISSION_DENIED` for `aiplatform.endpoints.predict`, replacing the earlier `API_KEY_SERVICE_BLOCKED`. Google names a resource in `southamerica-west1` for `gemini-3.7-flash`; no project, location, or base-URL override was configured locally, and the adapter defaults to the global API-key endpoint. This confirms a changed authorization boundary, not successful inference or model availability. The identity used by the key needs prediction access to the intended resource; the provider's error also allows that the resource may not exist. The certification remains blocked.

### Vertex success after IAM propagation and tool-schema correction

After the service-account role assignment, minimal generation passed through both the default API-key route and an explicit global project route. The next full gate passed streaming and Postgres but exposed HTTP 400 on tools: Vertex rejected `$schema` inside `functionDeclarations[].parameters`.

The local patch now applies the existing `toVertexSchema()` conversion to callable tool parameters, matching the conversion already used for structured output. The regression test failed before the fix and passed after it; it covers strict nested schemas and preservation of required integer fields. A patch changeset is included for `@zhivex-ai/vertex`.

On source `d1df46e67dff0882fb485c9f7054495749017d47` **plus the uncommitted Vertex schema fix**, the Vertex-only durable gate passed **3/3** with `gemini-3.7-flash`: approval/restart/journal, streaming/final persistence, and real Postgres claims/CAS/leases/journal ownership. Full deterministic validation passed **2,061 tests in 147 files**, typecheck and clean build.

A temporary Vertex-only adaptation of `agent-package-live-smoke.ts` and `agent-installed-live-smoke.mjs` packed Core, Agents and Vertex, installed them into an isolated consumer with the local Core override, and retained the existing approval/restart/single-execution/journal assertions. It emitted `Installed agent live smoke: vertex/gemini-3.7-flash PASS` and `INSTALLED_AGENT_LIVE_SMOKE_OK`. This is a separate Vertex-only installed run; the standard installed script still targets Gemini, DeepSeek and Qwen.

This establishes local source and installed-tarball evidence for the Vertex durable route. It does not certify Vertex realtime or resolve the direct Gemini billing and DeepSeek content failures above. Bun remains `1.4.0`; repeat release gates on the committed release source with the required runtime before publishing.

## 2026-08-05 result

Status: **PASS**

The certification changes were developed from base commit `f6be547` and passed
the live agent gate with the Postgres compatibility fixes described below:

```text
Test Files  1 passed (1)
Tests       7 passed (7)
Duration    15.53s
```

The installed-tarball gate also passed and emitted:

```text
Installed agent live smoke: gemini/gemini-3.6-flash PASS
Installed agent live smoke: deepseek/deepseek-v4-flash PASS
Installed agent live smoke: qwen/qwen3.7-plus PASS
INSTALLED_AGENT_LIVE_SMOKE_OK
```

The certified matrix was:

| Provider | Model | Approval/restart/tool journal | Streaming/persistence |
| --- | --- | --- | --- |
| Gemini | `gemini-3.6-flash` | PASS | PASS |
| DeepSeek | `deepseek-v4-flash` | PASS | PASS |
| Qwen | `qwen3.7-plus` | PASS | PASS |

Postgres ran in the local `bnapostgres` Docker container using
`postgres:latest`, reporting server version `18.1 (Debian 18.1-1.pgdg13+2)`.
The independent Postgres case also passed real concurrent idempotency claims,
compare-and-swap revision enforcement, lease ownership/expiry, and exactly-once
tool-journal claims across two separate clients. It persisted and reloaded agent
memory through a JSONB column as well.

## Certified behavior

For each provider, the gate:

1. sends a real request that produces a local `certify_add` tool call;
2. persists a `waiting_approval` run without executing the tool;
3. closes the first Postgres client to simulate a process restart;
4. loads the run through a new client, approves it, and resumes it;
5. proves the tool executed exactly once and its completed journal entry survived;
6. streams a second real run and verifies the complete event lifecycle and final
   persisted state.

The certification found and fixed two Postgres issues before producing the PASS:

- JSON values were pre-stringified before being handed to `postgres.js`, which
  stored JSONB strings instead of JSONB objects and broke run rehydration.
- simultaneous cold table creation could surface PostgreSQL `23505` on
  `pg_type_typname_nsp_index`; the store now retries that exact catalog race and
  clears failed initialization state.

The installed gate builds and packs `core`, `agents`, Gemini, DeepSeek, and Qwen,
installs them through `file:` dependencies in a temporary Bun consumer, and
repeats the approval/restart/exactly-once journal path using only public package
entrypoints. Its consumer-level `overrides` entry points every internal Core
dependency at the local Core tarball, which simulates the intended release batch
without accidentally loading the older Core version currently available from
npm.

## Reproduction

Set the three provider credentials in `.env`, then run against a disposable
database:

```bash
ZHIVEX_POSTGRES_INTEGRATION_URL=postgres://user:password@127.0.0.1:5432/database \
bun run test:integration:agents
```

The gate is fail-closed: missing requested providers or a missing Postgres URL
cause an error rather than skipped tests. Provider secrets are never included in
the test output.

This is a date-bound certification of the local source checkout and its locally
installed tarballs. It is not yet proof of an npm-published artifact, dist-tag,
or provenance.
