# @zhivex-ai/ag-ui

Opt-in adapter from a Zhivex agent stream to [AG-UI 1.0](https://docs.ag-ui.com/spec/1.0/schema) events, plus a server-side gate for client approval decisions.

The package is not imported by `@zhivex-ai/sdk` or `@zhivex-ai/core`. It does not add a dependency on an AG-UI runtime. Client decisions call the existing control-plane `resumeApproval` API, which resumes the run and writes the governance ledger.

```bash
bun add @zhivex-ai/ag-ui @zhivex-ai/core
```

```ts
import { createAgentControlPlane } from "@zhivex-ai/core";
import { collectAgUiEvents, createClientApprovalSession } from "@zhivex-ai/ag-ui";

const controlPlane = createAgentControlPlane({ agent });
const session = createClientApprovalSession({ controlPlane });
const output = await controlPlane.run({ prompt });
const events = await collectAgUiEvents(recordedAgentEvents, {
  threadId: "thread-1",
  runId: output.state.runId
});
const pauses = output.state.status === "waiting_approval"
  ? session.publish(output.state)
  : [];
const record = await session.decide({
  runId: pauses[0].runId,
  provider: pauses[0].provider,
  approvalRequestId: pauses[0].approvalRequestId,
  approvalToken: pauses[0].approvalToken,
  approve: true,
  reason: "reviewed"
});
record.ledger;
```

`session.decide` ignores any queue item a client attaches. It loads the queue item it minted, checks the bearer token, and then calls `resumeApproval`. The returned ledger is that control-plane record.

## Event mapping

| Zhivex agent stream | AG-UI 1.0 |
| --- | --- |
| First event, and `agent-run-start` | `RUN_STARTED` with `protocolVersion: "1.0"` |
| `text-delta` | `TEXT_MESSAGE_START`, then `TEXT_MESSAGE_CONTENT`, then `TEXT_MESSAGE_END` when the message closes |
| `tool-call` | `TOOL_CALL_START`, `TOOL_CALL_ARGS` (JSON arguments), `TOOL_CALL_END` |
| `tool-result` | `TOOL_CALL_RESULT` |
| `agent-step-start` / `agent-step-finish` | `STEP_STARTED` / `STEP_FINISHED` (`step:<index>`) |
| `agent-run-update` | `STATE_SNAPSHOT` for the first public run view, then `STATE_DELTA` as an RFC 6902 patch |
| `agent-run-finish` with `completed` | Public state update, then `RUN_FINISHED` outcome `success` |
| `agent-run-finish` with `cancelled` or `cancel_requested` | `RUN_FINISHED` outcome `cancelled` |
| `agent-run-finish` with `failed` or `timed_out`, and `error` | `RUN_ERROR` |
| `agent-approval-request`, `tool-approval-request`, or `waiting_approval` / `suspended` | `RUN_FINISHED` outcome `interrupt`, reason `tool_approval` |
| `agent-approval-resolved` | `CUSTOM` named `zhivex.approval.resolved` (approve flag only) |
| `agent-compaction` | `ACTIVITY_SNAPSHOT` activity type `compaction` (counts and id only) |
| `provider-data` | `CUSTOM` named `zhivex.provider-data` with the provider name only |
| `image-generation` | `CUSTOM` named `zhivex.image` with media type and ids, without bytes |
| `finish` | Closes the open text message. Usage is reported on the terminal run event |

State snapshots use the public run view: status, steps, usage, and output text. They do not include messages, approval arguments, signatures, raw provider payloads, scope, or credentials.

Every model tool call, including an approval-gated one, streams its JSON arguments to the client through `TOOL_CALL_ARGS`. `includeArguments` only controls the separate `zhivex.approval.pause` event; if a tool's inputs must stay server-side, filter those events before sending them.

The interrupt metadata carries `provider`, `approvalRequestId`, `name`, and `kind`. The approval bearer token is not placed on the AG-UI event. `session.publish` returns a separate `zhivex.approval.pause` event for the browser. A logged AG-UI stream cannot approve a run by itself.

## Approval security

The server stores the trusted queue item from `createAgentApprovalQueue`. A client decision is accepted only when all of the following hold:

- The bearer token matches exactly one stored queue item.
- `runId`, `provider`, and `approvalRequestId` are that same item. A token from another run is `cross_run`.
- The token has not been used. A second decision is `replayed`.
- The token is not expired, superseded, or bound to a pending approval whose fingerprint changed. Those are `stale`. An expired token is dropped after that rejection. A later presentation of a dropped token is `forged`.
- An unknown token is `forged`.
- `reason`, when present, is a string of at most 1000 characters. Anything else is `invalid`.

`createClientApprovalSession` keeps its queue in the current process. Consumed and expired entries are pruned, and replaced tokens are kept only up to a fixed history cap. A decision has to reach the same process that published the pause. Multi-instance deployments must route each decision back to that process, or keep the tokens in their own store and perform these checks before calling `resumeApproval`. This package does not ship a shared approval store.

After those checks, `decide` calls `controlPlane.resumeApproval`. That API checks the token, expiry, and fingerprint again, consumes the pending approval, and resumes through `resumeAgent`. The ledger is the control-plane record from that resume. Rejected decisions do not resume the run and do not write a second ledger format.

`publish` keeps the run's store scope from the server-side state. `decide` passes that scope to `resumeApproval` unless the server caller supplies a different one. `handleClientApprovalDecision` does not read a scope from the client.

`handleClientApprovalDecision` reads the JSON decision, ignores extra fields such as a client-supplied queue item, and returns `{ ok, runId, status, outputText }` or `{ ok: false, code }`.

## Left out

Vue, Svelte, and other framework hooks, RSC, and `streamUI` are not part of this package. The React helpers are `useApproval` and `useObject` in `@zhivex-ai/react`. See `examples/client-approvals` for a mock-provider server and page.
