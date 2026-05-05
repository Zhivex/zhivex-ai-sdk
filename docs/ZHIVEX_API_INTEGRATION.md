# Zhivex API Integration

This SDK now fits inside the Zhivex API as the runtime engine. It should not replace the API boundary.

## Boundary

```text
External client
  -> zhivex-gateway-api / zhivex-api
    -> auth
    -> workspace/project resolution
    -> BYOK or managed provider key selection
    -> billing, budgets, rate limits
    -> audit and HTTP response contract
    -> zhivex-ai-sdk runtime
```

The SDK owns:

- provider-normalized generation
- `runAgent()` / `streamAgent()`
- `Runner + SessionService`
- declarative workflows
- artifact records
- local eval/report/replay helpers

The API owns:

- workspace and project identity
- public API keys
- BYOK storage and selection
- customer billing and budgets
- request authentication and authorization
- HTTP versioning and response shape
- product-level audit logs

## Chat Endpoint Shape

Use `Runner` behind an API endpoint when the product needs multi-turn chat.

```ts
const provider = resolveProviderForProject(project);

const agent = createAgent({
  model: provider(project.model),
  instructions: project.systemPrompt,
  tools: resolveToolsForProject(project)
});

const runner = createRunner({
  appName: workspace.id,
  agent,
  sessionService: createPostgresSessionService({
    client: db
  })
});

const result = await runner.run({
  userId: caller.id,
  sessionId: request.sessionId,
  prompt: request.message,
  metadata: {
    projectId: project.id,
    requestId
  }
});

return {
  id: result.output.state.runId,
  sessionId: result.session.sessionId,
  status: result.output.status,
  outputText: result.output.outputText
};
```

Run tenant checks, budget checks, provider key selection, and audit logging before or around this call. Do not push those concerns into `packages/core`.

## Workflow Endpoint Shape

Use workflows for product operations with durable intermediate state:

```text
intake -> classify -> research -> final
```

Recommended mapping:

- `WorkflowStateService`: durable workflow run state.
- `ArtifactService`: explicit reports, outputs, replay timelines.
- `SessionService`: per-user/session agent conversation context.

Keep `workflowKey` stable if the API exposes resume/replay semantics.

## Provider Keys

BYOK belongs in the API/control plane:

1. Authenticate request.
2. Resolve workspace/project.
3. Resolve managed key or customer key.
4. Construct provider adapter.
5. Construct agent/runner/workflow.

The SDK should only receive the already-resolved provider adapter.

## Gateway Compatibility

This SDK work intentionally avoids:

- `workspaceId` in core types
- `projectApiKey` in core types
- billing objects in core types
- HTTP servers in core
- auth middleware in core
- BYOK storage in core

That is the correct separation. It keeps the SDK reusable by apps, and lets Zhivex API remain the product/security boundary.

## First Pilot

Start with one internal endpoint:

```text
POST /internal/agent-sessions/:sessionId/runs
```

Pilot requirements:

- one provider/model
- one `Runner`
- Postgres `SessionService`
- request/user/workspace audit around the runner call
- no public contract change until smoke is stable

Once stable, expose the behavior through the public API response shape.
