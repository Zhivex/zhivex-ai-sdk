# Experimental MCP server

Import `createMcpServer`, `createMcpHttpServer`, `createMcpStdioServer`,
`McpServerError`, and `MCP_SERVER_PROTOCOL_VERSION` from
`@zhivex-ai/sdk/mcp-server` or `@zhivex-ai/core/mcp-server`. Bind process stdio
with `serveMcpStdio` from `@zhivex-ai/sdk/mcp-server-stdio` or
`@zhivex-ai/core/mcp-server-stdio`. Every runtime export is Experimental.
`MCP_SERVER_API_STABILITY_MANIFEST` and `MCP_SERVER_STDIO_API_STABILITY_MANIFEST`
are separate from the root `API_STABILITY_MANIFEST`.

These entrypoints are server-only. Agent streaming uses `node:crypto`, and the
stdio binder uses `node:stream`. Browser bundles of `mcp-server-stdio` resolve
a stub that throws `McpServerError` with `UNSUPPORTED_RUNTIME` and does not
reference Node built-ins. Do not import either entry from root
`@zhivex-ai/sdk`, `@zhivex-ai/sdk/ui`, or `@zhivex-ai/sdk/experimental`.
`@zhivex-ai/agents` does not re-export this server; agent applications import
the SDK or Core subpath directly.

The [stable Streamable HTTP client](./MCP_HTTP.md) and the
[experimental stdio client](./MCP_STDIO.md) talk to other MCP servers. This page
is the reverse: Claude Code, Cursor, and other MCP clients call Zhivex tools
and agents.

`@modelcontextprotocol/sdk` is a pinned development dependency used as an
in-process client in tests. It is not a runtime dependency. Publishing it would
ship Express, Hono, and the rest of its server stack inside Core. The server
implements the same MCP `2025-11-25` subset the Zhivex client already speaks.

```ts
import { Agent, tool } from "@zhivex-ai/sdk";
import { createMcpHttpClient } from "@zhivex-ai/sdk/mcp-http";
import { createMcpHttpServer, createMcpServer, McpServerError } from "@zhivex-ai/sdk/mcp-server";
import { z } from "zod";

const server = createMcpServer({
  name: "zhivex",
  version: "0.0.0-experimental",
  tools: {
    echo: tool({
      name: "echo",
      description: "Repeat text",
      schema: z.object({ text: z.string() }),
      execute: async ({ text }) => ({ text })
    })
  },
  agents: {
    helper: {
      agent: new Agent({ name: "helper", model, instructions: "Answer briefly." })
    }
  }
});

const http = createMcpHttpServer(server, {
  allowedHosts: ["mcp.example.com"],
  authenticate(request) {
    if (request.headers.get("authorization") !== "Bearer secret") {
      throw new McpServerError("AUTH_REQUIRED", "Bearer token required.");
    }
  }
});
```

`examples/sdk/mcp-server.ts` runs the same shape with a mock model and an
in-process client. It does not need provider credentials.

## Tools

`tools` accepts a `ToolSet` of local callable tools. Hosted provider tools are
rejected at registration. The MCP name is `tool.name`, not the record key.
Names must match `/^[A-Za-z0-9_-]{1,128}$/`. Tools and agents share one
namespace; a duplicate name throws `McpServerError` before the server starts.

Zod object schemas are converted with Zod `toJSONSchema`. The draft `$schema`
keyword is removed. The advertised schema is `type: "object"`. Non-object
schemas throw at registration. `tools/list` does not paginate.

Each `tools/call` validates arguments, then runs `isEnabled`, input guardrails,
and output guardrails. Validation issues returned to the client contain only
Zod issue codes and paths. Received values are omitted. `onError` is not
called. The execution context uses a placeholder model that cannot generate
text; direct tool calls do not start a provider request.

## Agents as tools

Each `agents` entry is one MCP tool. The default input schema is
`{ prompt: string }`. `toRunInput` can map those arguments onto `prompt`,
`system`, and `maxSteps`. The default name is the entry `name`, then the agent
name, then its id, then the record key.

Every call starts a fresh `streamAgent` run. The server does not resume a
previous run. When the client sends `_meta.progressToken`, text deltas, tool
names, and an approval pause are forwarded as `notifications/progress`. Progress
text is trimmed, control characters are replaced, and each message is capped at
180 characters. Arguments and run state are not included. Step indexes are not
emitted.

On Streamable HTTP, progress is written only when the POST `Accept` header
includes `text/event-stream` and a progress token is present. The response is
then `text/event-stream` with `event: message` frames. JSON-only clients still
receive the final tool result; progress for that call is dropped. Stdio writes
each progress notification as its own line before the response.
`initialize` stays a JSON response so `Mcp-Session-Id` can be set.

A completed run returns the agent text as the tool `content` text and
`{ status, runId, outputText }` as `structuredContent`.

## Approval

MCP elicitation is not a Zhivex approval. A durable approval carries an input
digest, a tool version, and a signer, and resume goes through `Agent.resume`.
This server does not advertise elicitation and does not accept approval
responses. Clients that need a human decision keep that decision in the host.

The server never executes a tool whose `requiresApproval` is true. The tool
result is `isError: true` with `structuredContent.code` set to
`APPROVAL_REQUIRED`, `executed: false`, and the configured `approvalMode`
(`policy` when omitted). `execute` is not called.

An agent registration with `requiresApproval: true` is not started. The same
`APPROVAL_REQUIRED` result is returned with `executed: false`.

An agent run that reaches `waiting_approval` is not resumed. The result is
`APPROVAL_REQUIRED` with `executed: true`, `status: "waiting_approval"`,
`runId`, and `approvals` of `{ id, name, kind }`. Arguments and `rawData` are
omitted. Attach a run store on the agent if the host will resume that run
outside MCP.

## HTTP

`createMcpHttpServer` returns `{ fetch, close }`. Mount `fetch` on any host
that can pass a standard `Request` (Node, Bun, or a platform adapter). One
transport owns one server: `close()` aborts that server and any in-flight call.

Authentication runs before the body is read. Throw `McpServerError` with
`AUTH_REQUIRED` for 401 and `WWW-Authenticate: Bearer`, or `AUTH_REJECTED` for
403. Any other throw is also 401 with a fixed body-less response. The hook is
not OAuth. The host checks its own bearer token, session, or network identity.

When `allowedHosts` is set, the `Host` header must match exactly. If the
runtime does not expose `Host`, the host of `request.url` is used. When
`allowedOrigins` is set, `Origin` must match exactly and a missing origin is
rejected. Both checks return 403. Defaults are off: a public deployment must
set them.

`POST` requires `Content-Type: application/json` and an `Accept` value that
includes `application/json` or `text/event-stream`. `MCP-Protocol-Version`,
when present, must be `2025-11-25`. `initialize` creates a session and returns
`Mcp-Session-Id`. Later requests without that session, and `DELETE` of an
unknown session, return 404. `DELETE` of a live session returns 200 and drops
it. `GET` returns 405 with `Allow: POST, DELETE`. There is no server-initiated
SSE stream. JSON-RPC batches are rejected. `notifications/initialized` is
required before `tools/list` and `tools/call`. `ping` is answered earlier.
Unknown methods return JSON-RPC `-32601`.

## Limits

| Option | Default | Applies to |
| --- | --- | --- |
| `timeoutMs` | 30 seconds | One tool call, including `isEnabled` and guardrails, or one agent run. HTTP may set a shorter request timeout. |
| `maxResultBytes` | 1 MiB | Serialized tool or agent result. The body is withheld. |
| `maxRequestBytes` | 1 MiB | HTTP `Content-Length` and the bytes actually read. |
| `maxResponseBytes` | 4 MiB | One HTTP JSON body or the SSE frames of one POST. |
| `maxMessageBytes` | 4 MiB | One stdio line, inbound or outbound. |

A timeout or cancellation after `execute` has started returns `TIMEOUT` or
`CANCELLED` and tells the client to reconcile. The side effect may already
have happened. `LIMIT_EXCEEDED` on a result also means the tool or agent
already ran; the payload is not included. Oversized HTTP requests return 413
and are not dispatched.

`notifications/cancelled` aborts the matching in-flight call. Numeric and
string JSON-RPC ids stay distinct, so `1` does not cancel `"1"`. The server
does not invent an idempotency key.

An outbound stdio message larger than `maxMessageBytes` is replaced by a
JSON-RPC error when that error fits. When even the error does not fit, the
session ends instead of leaving the client waiting.

## Stdio

`createMcpStdioServer` reads and writes newline-delimited UTF-8 JSON-RPC on web
streams. `serveMcpStdio` adapts `process.stdin` and `process.stdout` on Node
and Bun. Logging belongs on stderr. Messages must not contain embedded
newlines. Control messages are handled in order. `tools/call` is not awaited
inside the reader, so a later `notifications/cancelled` can abort it.

## Protocol subset

The server pins the [2025-11-25 transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports):
`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`,
`notifications/progress`, and `notifications/cancelled`. It does not implement
resources, prompts, sampling, roots, elicitation, subscriptions, legacy
HTTP+SSE, or the 2026 transport revision.

## Limitations

- Experimental: names and options can change before a stable release.
- One transport per server instance. Closing the transport closes the server.
- No MCP elicitation and no approval resume on this connection.
- Progress on HTTP requires a progress token and `Accept: text/event-stream`.
- `GET` does not open a long-lived server stream.
- The host owns authentication, `allowedHosts`, `allowedOrigins`, and network exposure.
- A timed-out or oversized result can mean the tool already ran. Reconcile before retrying.
