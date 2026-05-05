# Production Guide

This SDK is a runtime library. Your application still owns auth, tenancy, billing, provider credentials, rate limits, and HTTP contracts.

## Recommended Architecture

```text
Client
  -> your API route/server action
    -> auth and tenant lookup
    -> provider/model selection
    -> Runner or Workflow
    -> durable SessionService / WorkflowStateService / ArtifactService
```

Keep this boundary:

- Browser: UI, user input, display state.
- App/API server: SDK usage, provider credentials, tools, stores, policy.
- Database/object store: durable session, workflow state, artifact metadata, blobs.

## Store Choices

Use the lowest durable store that matches the runtime:

| Runtime | Recommended store |
| --- | --- |
| Unit tests | in-memory |
| Local scripts | file-backed |
| Local app demo | file-backed or SQLite |
| Long-running Node service | Postgres or SQLite |
| Serverless / Vercel | Postgres |
| Large binary artifacts | file/in-memory for SDK-managed blobs, or app-owned object storage with external artifact references |

File-backed stores are intentionally simple and inspectable, but they rely on local disk. In serverless production, that disk may disappear or differ between instances.

## Identity Mapping

The SDK uses application-level identifiers:

- `appName`: logical application or tenant namespace.
- `userId`: app-resolved user identifier.
- `sessionId`: app-visible conversation/session key.

In a SaaS API, you can map these from your own control plane:

```ts
const runner = createRunner({
  appName: workspace.id,
  agent,
  sessionService
});

const result = await runner.run({
  userId: authenticatedUser.id,
  sessionId: request.sessionId,
  prompt: request.message
});
```

Do not put workspace, API key, billing, or BYOK rules inside the SDK layer. Resolve them before constructing the agent/runner.

## Concurrency

Durable records include `revision`. Stores support compatible last-write-wins by default, and optimistic concurrency when you pass `expectedRevision`.

```ts
const session = await sessionService.loadSession(lookup);

if (session) {
  await sessionService.saveSession(updatedSession, {
    expectedRevision: session.revision
  });
}
```

If the stored revision changed, the SDK raises `ConflictError`.

## Workflows

Use workflows when the process has named steps:

```text
intake -> research -> review -> final
```

Use `WorkflowStateService` for durable workflow state. Session metadata fallback exists for compatibility and compact apps, but the first-class state service is the recommended production shape.

## Artifacts

Use artifacts for outputs you want to keep, inspect, or attach to workflow steps:

- workflow final reports
- intermediate JSON outputs
- generated files
- evaluation reports
- replay timelines

For large production binaries, prefer app-owned blob storage and keep an SDK artifact record as metadata:

```ts
import { createExternalArtifactReference } from "@zhivex-ai/sdk";

await artifactService.saveArtifact({
  appName,
  userId,
  sessionId,
  name: "contract.pdf",
  contentType: "application/pdf",
  data: createExternalArtifactReference({
    uri: "s3://bucket/path/contract.pdf",
    storageProvider: "s3"
  }),
  metadata: {
    kind: "external-file"
  }
});
```

## Operational Checklist

- Use server-side SDK imports only.
- Keep provider keys in server environment variables or your secret manager.
- Use Postgres for shared production session state.
- Keep `Runner + SessionService` as the default chat/multi-turn surface.
- Use workflows only when named steps and replay/eval matter.
- Store artifacts explicitly; `runWorkflow()` does not auto-save them.
- Log `runId`, `sessionId`, `status`, and provider/model identifiers.
- Treat Beta surfaces behind an app-owned abstraction until they are promoted.
