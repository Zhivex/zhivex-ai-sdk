# Opt-in MCP HTTP and OAuth

Import `createMcpHttpClient`, `createMcpOAuthProvider`, `collectMcpPages`, and
`McpHttpError` from `@zhivex-ai/sdk/mcp-http` or `@zhivex-ai/core/mcp-http`.
The root MCP tools adapter keeps accepting existing tools-only clients. Resources,
resource templates and prompts are optional additions to `McpClient`.

```ts
import { createMcpHttpClient, collectMcpPages } from "@zhivex-ai/sdk/mcp-http";

const client = createMcpHttpClient({
  url: "https://mcp.example.com/mcp",
  destinationPolicy: (url) => url.origin === "https://mcp.example.com",
  maxResponseBytes: 2 * 1024 * 1024,
  timeoutMs: 15_000
});
const resources = await collectMcpPages(async (cursor, options) => {
  const page = await client.listResources!({ cursor }, options);
  return { items: page.resources, nextCursor: page.nextCursor };
}, { maxPages: 20, maxItems: 500 });
const contents = await client.readResource!({ uri: resources[0].uri });
client.close();
```

The transport pins the [2025-11-25 Streamable HTTP contract](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
negotiates capabilities, handles JSON and SSE POST responses, session identifiers,
server ping requests, opaque pagination cursors, byte limits and cancellation.
Unknown server requests receive method-not-found because this client advertises
no sampling, roots or elicitation capability. It does not implement legacy
HTTP+SSE, background GET streams, subscriptions, resumable SSE, or the newer
2026 transport revision. `close()` cancels local work; it does not delete the
remote session. A session-expiry 404 clears negotiation so the next explicit call
can initialize again. It never automatically replays a request.

Resource URIs are sent to `resources/read`, never opened directly by the SDK.
Text and base64 binary content, prompts and server annotations remain untrusted
input; the host chooses how to render, store or include them in model context.
Resource reads and prompts do not become tools or receive approval implicitly.
The existing `createMcpToolSet` approval behavior is unchanged.

## OAuth and host responsibilities

The opt-in OAuth provider implements public-client authorization code flow using
S256 PKCE and single-use state, based on the [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
The host supplies a pre-registered client ID (or registered client metadata URL),
exact trusted issuer, exact resource, callback URI, destination policy and token
store. No browser is opened, credentials written to disk, or permissions granted
by importing or constructing the provider.

```ts
import { createMcpHttpClient, createMcpOAuthProvider, McpHttpError }
  from "@zhivex-ai/sdk/mcp-http";

const auth = createMcpOAuthProvider({
  resource: "https://mcp.example.com/mcp",
  issuer: "https://login.example.com",
  clientId: "your-registered-client-id",
  redirectUri: "http://127.0.0.1:8080/callback",
  destinationPolicy: (url) => ["mcp.example.com", "login.example.com"].includes(url.hostname),
  tokenStore: hostCredentialStore // async load(), save(tokens), clear()
});
const client = createMcpHttpClient({ url: "https://mcp.example.com/mcp", auth });
try {
  await client.initialize();
} catch (error) {
  if (!(error instanceof McpHttpError) || error.code !== "AUTH_REQUIRED") throw error;
  const start = await auth.beginAuthorization({ challenge: error.authorization });
  // The host obtains approval, opens start.authorizationUrl and receives callbackUrl.
  // await auth.completeAuthorization(callbackUrl);
}
```

Discovery supports protected-resource challenge metadata, path/root well-known
fallbacks, RFC 8414 and OIDC metadata. Issuer, resource and client bindings are
checked before using credentials. Every discovered endpoint passes the host
policy; every HTTP request rejects redirects. Tokens are sent only to the exact
MCP endpoint. The host must enforce network/DNS destination restrictions in its
fetch implementation and isolate credential stores by tenant, issuer, resource
and client. HTTPS is mandatory for network destinations; callback URIs additionally
allow IP loopback HTTP. Dynamic client registration is outside this implementation.

Refresh is singleflight within a provider instance, and callers can cancel their
own wait. A refresh credential is removed from the host store before a potentially
rotating exchange. If the response is lost or persistence fails, fresh authorization
is required rather than retrying a possibly consumed credential. This conservative
behavior also requires reauthorization after a process crash during refresh.
Share one provider per credential store; cross-process coordination belongs to
the host store. Store writes and clearing are serialized within an instance.

`AUTH_REQUIRED`, `AUTH_EXPIRED` and `AUTH_REJECTED` are distinct from transport
failures. A tool request with a lost, invalid or oversized response produces
`INDETERMINATE`: reconcile the remote effect before retrying. An idempotency key
from the tool adapter does not imply MCP server deduplication. Authentication
errors never trigger automatic tool replay. Error messages exclude remote bodies
and bearer tokens; authorization challenge fields are untrusted metadata and
must not be logged as credentials or used without destination validation.

## Interoperability evidence

`packages/core/tests/mcp-http.test.ts` covers negotiation, byte limits, cancellation,
OAuth binding, state, singleflight refresh, session expiration, and credential races.
`scripts/verify-mcp-http-interop.ts` exercises the official MCP TypeScript SDK
1.27.1 server in both JSON and SSE modes: tools, resource lists, templates, text,
binary and prompts. Install that server in a temporary directory using Bun, then:

```sh
bun scripts/verify-mcp-http-interop.ts /path/to/node_modules/@modelcontextprotocol/sdk/dist/esm
```

This verifies in-process protocol interoperability, not a deployed OAuth server,
DNS policy, registry publication or Harness migration. Harness should consume a
published version and validate its credential-store and approval integration
before removing its local transport.
