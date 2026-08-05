# Agent Live Certification Evidence

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
