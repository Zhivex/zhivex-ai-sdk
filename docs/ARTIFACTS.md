# Stable Artifact Service Contract

`ArtifactService` is the Stable persistence contract for application, session, workflow, step, and agent-run artifacts. `@zhivex-ai/core` and `@zhivex-ai/sdk` expose equivalent in-memory, file, SQLite, and Postgres implementations.

## Versioning and identity

New records use `ARTIFACT_SCHEMA_VERSION` and revision `1`. Existing schema-v1 records retain `createdAt` and increment `revision` on update. Legacy unversioned records are normalized to v1; unknown future schema versions fail closed.

An artifact is addressed by the complete tuple `appName`, `userId`, `sessionId`, and `id`. List queries are tenant-scoped by the first three values and may additionally filter by workflow run, workflow step, or agent run. Required identifiers and descriptive fields must be non-empty strings.

Updates accept `expectedRevision`. In-memory, SQLite, and Postgres implementations enforce compare-and-swap semantics. The file implementation checks revisions but is intended for local or single-process use; it is not a cross-process lock.

## Bounded payloads

All built-in services enforce the same configurable UTF-8 or decoded-byte limits:

| Limit | Default |
| --- | ---: |
| JSON data | 1 MiB |
| Text data | 1 MiB |
| Decoded base64 data | 16 MiB |
| Binary data | 16 MiB |
| Metadata | 64 KiB |
| Complete serialized record | 24 MiB |

Pass a partial `limits` object to any service factory. Limits must be positive safe integers. `DEFAULT_ARTIFACT_SERVICE_LIMITS` exposes the defaults and `resolveArtifactServiceLimits()` validates and fills a partial policy.

```ts
import { createPostgresArtifactService } from "@zhivex-ai/sdk";

const artifacts = createPostgresArtifactService({
  client,
  limits: {
    maxJsonBytes: 512 * 1024,
    maxBinaryBytes: 8 * 1024 * 1024
  }
});
```

Validation is applied on writes and on records loaded from durable storage. JSON and metadata must serialize successfully. Base64 must be canonical and valid, and caller-supplied size or SHA-256 metadata must match the decoded bytes.

## Storage modes

- In-memory and file services retain native binary bytes separately from their JSON metadata records.
- SQLite and Postgres encode binary bytes into the schema-v1 JSON compatibility record.
- File blob paths are generated and validated by the SDK under the configured `blobs/` directory.
- Large production objects may remain in app-owned blob storage. `createExternalArtifactReference()` records a URI and optional size/digest without claiming that the SDK can fetch or verify the external bytes.

`verifyArtifactIntegrity()` reports `external-data-unavailable` for a valid external reference. Applications must verify those bytes in their own storage layer. SDK-managed binary and base64 artifacts can be checked for missing data, invalid base64, size mismatches, and digest mismatches.

## File maintenance

`inspectFileArtifactStore()` reports invalid metadata, missing blobs, and orphan blobs. `cleanupFileArtifactStore()` removes only orphan blobs and supports `dryRun`. `pruneFileArtifactStore()` is dry-run by default and requires `dryRun: false` to delete matching artifact records and their managed blobs.

New file-store directories use mode `0700` and metadata/blob files use `0600` where POSIX permissions are available. Paths derived from artifact identity use canonical collision-resistant keys, while legacy paths are read for compatibility and migrated on write.

## Release evidence

The deterministic suites exercise all four backends through the shared contract. SQLite certification uses a real database. Postgres certification and the installed-tarball Postgres smoke require the explicit release DSN and run in the isolated CI service; an absent local DSN is a skipped live certification, not a passing database claim.
