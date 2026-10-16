# Experimental Agent2Agent (A2A)

Import the server and client from `@zhivex-ai/sdk/a2a` or `@zhivex-ai/core/a2a`.
Every runtime export is Experimental and listed by the frozen
`A2A_API_STABILITY_MANIFEST`. That manifest is separate from the root
`API_STABILITY_MANIFEST`. The entrypoint stays off `@zhivex-ai/sdk` and
`@zhivex-ai/sdk/experimental` so `node:http` stays out of browser-safe bundles.
Browser bundles keep `RemoteA2aAgent` and throw from `createA2aAgentServer`.

This layer targets the released A2A specification **1.0.0**. Clients and
servers negotiate with the `A2A-Version: 1.0` header. A missing or different
header is rejected. The implementation speaks JSON-RPC 2.0 over HTTP and does
not depend on a third-party A2A package.

Normative methods are `SendMessage`, `SendStreamingMessage`, `GetTask`, and
`CancelTask`. The pre-1.0 names `message/send`, `message/stream`, `tasks/get`,
and `tasks/cancel` are accepted as aliases. The Agent Card is served at
`/.well-known/agent-card.json`.

## Server

`createA2aAgentServer` exposes one Zhivex agent. `contextId` is the Runner
session id and `taskId` is the agent run id. Task snapshots and the
task/message index live in the supplied `SessionService`, including file,
SQLite, and Postgres stores, so `GetTask` and an approval resume work after
the process restarts.

`waiting_approval` and legacy `suspended` runs are reported as
`TASK_STATE_INPUT_REQUIRED`. Resume by sending another user message on the
same `taskId` with a data part:

```json
{ "approvals": [{ "approvalRequestId": "<id>", "approve": true }] }
```

The id comes from the input-required status message. Tool arguments and raw
provider payloads are not copied onto the wire. A message id is idempotent:
a repeat returns the stored task and does not start another model call.

Blocking `SendMessage` waits for a terminal or input-required state.
`SendStreamingMessage` is `text/event-stream`. Each event is a JSON-RPC
envelope whose `result` is a `task`, `artifactUpdate`, or `statusUpdate`.
`returnImmediately: true` is rejected.

Pass `authenticate` to require a caller-defined check on every JSON-RPC
request. The Agent Card stays public. When the hook is omitted, pass a
single-tenant `userId`. The default bind address is `127.0.0.1`. An IPv6
bind address is bracketed in the advertised URL, for example
`http://[::1]:port/rpc`. `0.0.0.0` and `::` are still advertised as
`127.0.0.1`. Request bodies default to 1 MiB (`maxRequestBytes`). A
`Content-Length` that is not a decimal integer, or that is larger than the
limit, is rejected before the body is buffered. `historyLength` above the 32
messages stored on a task is clamped to that cap. Values outside the int32
range `0..2147483647` are rejected. JSON-RPC ids of type string, number
(including `0`), or `null` are echoed. The server stops waiting on
`authenticate` when the client disconnects or the server closes; the hook
itself stays host-owned.

## Client

`RemoteA2aAgent` fetches the Agent Card, selects the JSON-RPC interface whose
`protocolVersion` is `1.0`, and calls `send`, `stream`, `getTask`, and
`cancelTask`. `getTask` and `cancelTask` repeat that interface's `tenant`
when the card sets one, the same way `send` does. `createRemoteA2aAgentTool`
wraps that client as a Zhivex tool so a parent agent can delegate through
`tools`. An input-required remote task is returned to the parent instead of
blocking it.

`timeoutMs` defaults to 60 seconds and must be a positive safe integer no
greater than `2147483647`. The deadline covers destination checks, the
`headers` callback, header receipt, and response body or event-stream
consumption. A stalled body rejects with `A2A request timed out.` A failed
card or endpoint lookup is not cached, so a later call can retry.

Every card and RPC URL passes `assertA2aDestination` before `fetch`.
Non-loopback URLs also pass `checkMcpDestination` with purpose `"server"`.
Private, link-local, metadata, credentialed, and hashed URLs are rejected.
Plain HTTP is rejected unless `allowLoopbackHttp` is set and the host is
loopback. `fetch` uses `redirect: "error"`. A `destinationPolicy` callback
can reject a URL that the static checks allow. This does not pin DNS answers;
deployments still need egress controls so a public name cannot rebind to a
private address.

```ts
import { createAgent, createInMemorySessionService, runAgent } from "@zhivex-ai/sdk";
import { createA2aAgentServer, createRemoteA2aAgentTool } from "@zhivex-ai/sdk/a2a";

const remote = await createA2aAgentServer({
  appName: "support",
  userId: "user_1",
  agent: createAgent({ model }),
  sessionService: createInMemorySessionService(),
  card: { name: "Support", description: "Answers product questions." }
});

const parent = createAgent({
  model,
  maxSteps: 3,
  tools: {
    support: createRemoteA2aAgentTool({
      name: "support",
      agent: { url: remote.cardUrl, allowLoopbackHttp: true }
    })
  }
});

const result = await runAgent(parent, { prompt: "Ask support." });
await remote.close();
```

`allowLoopbackHttp` is for a local server. A public remote agent uses `https`
and does not set that flag. `examples/sdk/a2a-roundtrip.ts` runs the same
shape with a deterministic model and no credentials. Build the workspace
before running it.

## Gaps

The entrypoint does not implement gRPC, the HTTP+JSON REST binding,
`ListTasks`, `SubscribeToTask`, push notifications, extended agent cards,
agent-card signatures, or protocol 0.3. File and URL parts are rejected.
`TASK_STATE_INPUT_REQUIRED` is produced for approval waits, not for free-form
model questions. `TASK_STATE_AUTH_REQUIRED` is not produced. One context keeps
a single resumable run because a session stores one `lastRunState`. Older
tasks remain readable. A task left in `TASK_STATE_WORKING` by a process crash
can be read and canceled; it is not restarted automatically.

Cancel is cooperative through `AbortSignal` and does not undo tool side
effects. JSON-RPC batches are rejected. `-32000` (authentication) and
`-32010` (local limits) are implementation codes in the reserved server-error
range. The in-process user lock serializes runs for one user; session writes
still use the store's revision check. History stored on a task is capped at
32 messages, stored text at 256 KiB, and the per-user task index at 100 tasks.
Artifact stream chunks set `append` and `lastChunk` on the final chunk. CORS
headers are not added.
