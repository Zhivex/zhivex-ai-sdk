# Agent Live Certification Evidence

## Recorded certification status

Latest recorded durable-agent attempt: **2026-09-19**, source `d1df46e67dff0882fb485c9f7054495749017d47`. The full matrix was **NOT CERTIFIED** (4 passed, 3 failed); the standard installed live gate stopped at Gemini billing failure.

| Provider | Recorded scope and result |
| --- | --- |
| Gemini | Approval and streaming failed with HTTP 429; installed live gate also failed. |
| DeepSeek | Approval/restart passed; streaming token assertion failed, including on repeat. A raw-SSE diagnostic localized the mismatch to upstream content. |
| Qwen | Source approval/restart and streaming passed; not reached by the standard installed live attempt. |
| Vertex | Subsequent Vertex-only source gate passed 3/3 with `gemini-3.7-flash`, plus a separately adapted installed-tarball smoke, on the source above plus an uncommitted tool-schema fix. Does not certify realtime. |

The earlier 2026-08-05 Gemini/DeepSeek/Qwen source and installed-tarball matrix passed. Neither historical run proves current npm artifact certification. September used Bun 1.4.0, below the requested 1.4.2; repeat gates on the immutable release source and required runtime.

Full attempt history and diagnostics are in the [internal historical archive in Notion](https://www.notion.so/418777b104f681a089c1c27e90679725).

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
