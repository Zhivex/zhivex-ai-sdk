# Optional Model Resolver (Beta)

`createModelResolver()` adds an opt-in `provider/model` lookup layer without
replacing provider factories or creating another runtime. It is available from
`@zhivex-ai/sdk/beta` and requires three application-owned decisions:

1. the immutable model catalog that defines valid identities and pricing;
2. either an explicit adapter map or one explicitly configured backend;
3. any shorthand aliases the application wants to own.

Provider factories remain the canonical and reversible path. Use the resolver
only when string identifiers materially simplify application configuration.

## Adapter registry

```ts
import { defaultModelCatalog, generateText } from "@zhivex-ai/sdk";
import { createModelResolver } from "@zhivex-ai/sdk/beta";
import { createAnthropic } from "@zhivex-ai/anthropic";
import { createOpenAI } from "@zhivex-ai/openai";

const resolver = createModelResolver({
  catalog: defaultModelCatalog,
  adapters: {
    openai: createOpenAI({ apiKey: process.env.OPENAI_API_KEY }),
    anthropic: createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  },
  aliases: [
    { alias: "support-default", target: "openai/gpt-5.6-terra" }
  ],
  onResolve(metadata) {
    // Safe for a trace or budget preflight. It contains no adapter config,
    // credential, header, or endpoint.
    console.log(metadata.resolved, metadata.catalogEntry, metadata.capabilities);
  }
});

const result = await generateText({
  model: resolver.model("support-default"),
  prompt: "Summarize the incident."
});
```

Use `resolve()` when the caller also needs the decision metadata:

```ts
const { model, metadata } = resolver.resolve("openai/gpt-5.6");

metadata.requested; // catalog alias requested by the app
metadata.resolved; // canonical catalog identity
metadata.catalogEntry; // immutable pricing/recommendation snapshot
metadata.capabilities; // immutable capability snapshot
```

The resolver splits on the first slash, so provider-specific model IDs may
contain additional slashes. For example, an OpenRouter adapter can resolve an
identifier such as `openrouter/anthropic/claude-sonnet-4` when that exact model
exists in the injected catalog.

## Application aliases

Aliases are an array rather than an object so duplicate declarations can be
detected before the registry is created. Alias names cannot contain `/`; this
prevents a shorthand from silently shadowing an explicit `provider/model`
identifier. Targets must be explicit references and cannot chain through other
application aliases.

The resolver snapshots the alias list and adapter map. Mutating the original
configuration later does not change an existing resolver, and each resolver is
instance-local, so concurrent applications or tests share no global state.

## Configured backend

Applications that deliberately use a gateway can provide a backend instead of
an adapter map. The backend receives the canonical identity only after the
catalog has accepted it:

```ts
import { createModelCatalog } from "@zhivex-ai/sdk";
import { createModelResolver } from "@zhivex-ai/sdk/beta";

const catalog = createModelCatalog([
  { provider: "openai", modelId: "gpt-5.6-terra" }
]);

const resolver = createModelResolver({
  catalog,
  backend: {
    name: "application-gateway",
    languageModel({ provider, modelId }) {
      return configuredGatewayModel(`${provider}/${modelId}`);
    }
  }
});
```

`configuredGatewayModel` is deliberately application code. This package does
not install, discover, or select a gateway. Vercel AI Gateway, an OpenRouter
adapter, and a Zhivex Gateway deployment are possible explicit backends, but
none is an implicit default:

- **Vercel AI Gateway:** wrap its already configured model factory in a
  `ModelResolverBackend` and inject an application-owned catalog.
- **OpenRouter:** normally register `@zhivex-ai/openrouter` as an adapter; use a
  backend wrapper only if the application intentionally models upstream
  provider identity separately.
- **Zhivex Gateway:** keep identity resolution separate from dynamic routing and
  fallback. The local `@zhivex-ai/gateway` package remains the routing layer; a
  hosted Gateway API, if used, must be configured and wrapped by the app.

## Preflight errors and security boundary

All resolver failures use `ModelResolutionError` with a machine-readable code:

- `invalid_configuration`
- `invalid_identifier`
- `alias_collision`
- `unknown_alias`
- `unknown_provider`
- `unknown_model`
- `invalid_resolved_model`

Unknown providers and models are rejected through the catalog before an
adapter/backend model factory is invoked. Resolution never performs a model
request. The registry does not read environment variables, discover
credentials, validate private endpoints, route by policy, or infer capabilities
missing from the returned model.

Keep backend endpoints and secrets inside the configured adapter/backend. Use a
short safe backend `name`; it is emitted in metadata and must not be a URL.

## Reversible migration

These forms are behaviorally equivalent after local resolution:

```ts
const direct = openai("gpt-5.6-terra");
const optional = resolver.model("openai/gpt-5.6-terra");
```

To roll back, replace `resolver.model(identifier)` with the matching direct
factory call. No stored global registry or resolver-specific runtime state must
be migrated.

See [ADR 0001](./adr/0001-explicit-model-resolver.md) for the design boundary
and [Model Catalog Contract](./MODEL_CATALOG.md) for catalog ownership and
snapshot rules.
