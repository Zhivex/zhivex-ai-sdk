# Experimental MCP stdio transport

Import `createMcpStdioClient`, `McpStdioError`, and `MCP_STDIO_PROTOCOL_VERSION`
from `@zhivex-ai/sdk/mcp-stdio` or `@zhivex-ai/core/mcp-stdio`. Every runtime
export is Experimental and listed by the frozen `MCP_STDIO_API_STABILITY_MANIFEST`.
That manifest is separate from the root `API_STABILITY_MANIFEST`. Declaration
snapshots cover the exported types. `createMcpToolRegistry` remains Beta.

This entrypoint is server-only. It spawns a child process with `node:child_process`.
Package exports send browser bundles to a stub that throws `McpStdioError` and
does not reference Node built-ins. Do not import it from root `@zhivex-ai/sdk`,
`@zhivex-ai/sdk/ui`, or other browser-safe entrypoints.

The [stable Streamable HTTP client](./MCP_HTTP.md) is the remote transport. Use
stdio only for a local server that does not speak HTTP, such as
[mcp-bcra](https://github.com/mortiz-dev/mcp-bcra).

```ts
import { Agent, createMcpToolRegistry, toToolSet } from "@zhivex-ai/sdk";
import { createMcpStdioClient } from "@zhivex-ai/sdk/mcp-stdio";

const client = createMcpStdioClient({
  command: "npx",
  args: ["-y", "mcp-bcra"],
  timeoutMs: 20_000
});

const registry = await createMcpToolRegistry(client, {
  includeTools: [
    "get-bcra-fx-currencies",
    "get-bcra-fx-quotes",
    "get-bcra-fx-quote-by-currency",
    "get-bcra-variables",
    "get-bcra-var-hist",
    "get-bcra-metodologia",
    "get-bcra-entities"
  ]
});

const agent = new Agent({
  model,
  tools: toToolSet(registry),
  maxSteps: 4
});
```

`command` and `args` are passed to `spawn` with `shell: false`. A shell string
such as `"npx mcp-bcra"` is not split and is not executed by a shell. When `env`
is omitted the child inherits the parent environment. When `env` is set it
replaces that environment; copy `PATH` yourself if the executable is resolved
from it.

## Protocol subset

The client pins the [2025-11-25 stdio contract](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports):
newline-delimited JSON-RPC on stdin/stdout, an `initialize` handshake, then
`notifications/initialized`. It accepts only protocol version `2025-11-25`.
Messages are UTF-8 and must not contain embedded newlines. Unknown server
requests, including sampling, roots, and elicitation, receive method-not-found.
`ping` is answered. Server notifications other than those required for the
handshake are ignored.

stderr is logging. The client keeps a bounded tail available from `stderr()`
and can forward chunks through `onStderr`. Stderr is never parsed as JSON-RPC
and is not copied into error messages.

`close()` is idempotent. It aborts local waits, closes stdin, waits
`shutdownGraceMs`, sends `SIGTERM` to the child process group, waits again, then
sends `SIGKILL`. On Windows it signals the direct child. Closing does not send
a protocol shutdown request. A failed initialization closes the process; create
a new client to try again. The process is not started until the first request.

The client does not implement the 2026 per-request metadata transport,
`server/discover`, legacy Content-Length framing, HTTP, OAuth, or automatic
replay. Servers that reject the 2025-11-25 `initialize` handshake are out of
scope. mcp-bcra's stdio entry serves that legacy handshake, which is the subset
this client speaks.

## Cancellation, crashes, and limits

Per-call `abortSignal` and `timeoutMs` cancel the local wait. After a
`tools/call` request has been written, cancellation, a timeout, a dropped
frame, or a process exit rejects with `INDETERMINATE`: reconcile before
retrying. The client also writes `notifications/cancelled`, but that
notification is not proof the server stopped. Calls that fail before dispatch,
and non-tool methods, reject with `PROCESS_EXITED`, `PROTOCOL_ERROR`,
`LIMIT_EXCEEDED`, `UNSUPPORTED_CAPABILITY`, or the abort reason.

`maxMessageBytes` bounds each stdin and stdout line (default 4 MiB). An
oversized `tools/call` response is `INDETERMINATE` because the tool may already
have run. `maxStderrBytes` bounds only the retained tail (default 64 KiB);
older stderr bytes are dropped and do not kill the server.

JSON-RPC error messages from the server are not included on `McpStdioError`.
An idempotency key on the tool adapter is not forwarded and does not imply
server deduplication.

## Allowlists

Stdio servers can expose tools the host does not want a model to call. Pass
`includeTools` to `createMcpToolRegistry` or `createMcpToolSet`. For mcp-bcra,
keep the allowlist to exchange rates, monetary variables, and entities. Do not
register debtor, cheque, or CUIT/CUIL lookups unless a separate reviewed flow
asks for them.

Server annotations stay untrusted unless `trustServerToolAnnotations` is set.
mcp-bcra marks tools read-only and open-world. Open-world annotations still
require approval in the agent loop, so a run can stop in `waiting_approval`
before the process receives `tools/call`. Resume with the host's own approval
decision. See `examples/sdk/mcp-stdio-bcra.ts`.

## Limitations

- Experimental: method names and options can change before a stable release.
- One process per client. There is no session resume, restart, or connection pool.
- Only the MCP 2025-11-25 initialize handshake. A 2026-only server will fail initialization.
- No sampling, roots, elicitation, subscriptions, or logging capability.
- Process-group shutdown is POSIX. Windows signals the direct child only.
- The host owns the executable, arguments, working directory, environment, and network policy of the child. The SDK does not sandbox it.
- `close()` cannot undo a tool effect that already happened.
