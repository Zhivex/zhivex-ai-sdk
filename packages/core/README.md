# @zhivex-ai/core

Shared contracts, runtime helpers, stream utilities, middleware, catalog helpers, and generation primitives for Zhivex AI SDK.

The Beta provider-conformance helpers (`normalizeProviderConformanceReport`, `compareProviderConformanceReports`, `evaluateProviderConformanceGate`, and `renderProviderConformanceMarkdown`) validate schema-versioned support evidence without persisting prompts, responses, or secrets. They distinguish declared, offline, installed-package, and authenticated live results and apply fail-closed TTL/baseline rules.

`@zhivex-ai/core` owns the stable catalog contract and `createModelCatalog`.
Its deprecated `defaultModelCatalog` export is a frozen compatibility snapshot
that remains available until the next major; the release-managed default
inventory and all future snapshot updates live in `@zhivex-ai/sdk`.

## Install

```bash
bun add @zhivex-ai/core @zhivex-ai/openai
```

## Usage

Use `@zhivex-ai/core` when you are building custom adapters or need the lower-level shared contract directly.

```ts
import { generateText } from "@zhivex-ai/core";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = await generateText({
  model: openai("gpt-4o-mini"),
  prompt: "Describe the shared provider contract."
});

console.log(result.text);
```

If you are implementing an adapter rather than running this example, `@zhivex-ai/core` can be installed on its own. Applications that want the recommended high-level entry point should use `@zhivex-ai/sdk`.

### Focused entry points

Use a focused import when an application does not need the complete server
surface. The package root remains backward compatible.

| Import | Intended surface | Node.js built-ins |
| --- | --- | --- |
| `@zhivex-ai/core/contracts` | Provider-neutral TypeScript contracts | No runtime module |
| `@zhivex-ai/core/runtime` | Adapter, message, tool, media, retrieval, and realtime primitives | None |
| `@zhivex-ai/core/workflows` | Portable workflow orchestration, evaluation contracts, diffs, and gates | None |
| `@zhivex-ai/core/ui` | UI messages, request parsing, and response streams | None |
| `@zhivex-ai/core/node` | Complete server surface, including file-backed stores and middleware | Yes |
| `@zhivex-ai/core/testing` | Evaluation harnesses and deterministic test doubles | Server/test runtimes |

```ts
import type { LanguageModel } from "@zhivex-ai/core/contracts";
import { createProviderAdapter, tool } from "@zhivex-ai/core/runtime";
import { createWorkflow } from "@zhivex-ai/core/workflows";
import { toUIMessage } from "@zhivex-ai/core/ui";
```

`generateText`, agents, middleware, persistence implementations, and all legacy
root exports remain available from `@zhivex-ai/core`. Prefer
`@zhivex-ai/core/node` when making the server-only dependency explicit.

Provider authors can model new capability metadata with the Beta discriminated
`ModelCapabilityProfile` contract and derive the existing boolean shape with
`deriveLegacyModelCapabilities()`. This keeps current providers compatible while
allowing `native`, `prompted`, and `model-dependent` support to remain explicit.

Most applications should install `@zhivex-ai/sdk` and follow the main adoption guides:

- Quickstart: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/QUICKSTART.md>
- Production guide: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/PRODUCTION.md>
- Artifact Service: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/ARTIFACTS.md>
- Model Catalog: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/MODEL_CATALOG.md>
- Observability: <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/docs/OBSERVABILITY.md>

## Stability

The shared realtime session and live-agent lifecycle is Stable, including
`CallbackRealtimeSession`, frame encoders, WebSocket helpers, and
`streamLiveAgent`. Provider-specific options and upstream preview model
availability remain provider-scoped. Review the machine-enforced manifest and
policy in <https://github.com/Zhivex/zhivex-ai-sdk/blob/main/STABILITY.md>.

## Security Defaults

- File-backed session, workflow, artifact, run, and memory stores create private directories and files (`0700`/`0600`) and use canonical opaque identity keys. Matching legacy delimiter-based records are read for compatibility and migrated on the next write.
- Generation cache keys are hashed and omit unsafe callback/signal identity. In-memory caches isolate entries by model instance unless `createCachedGenerateMiddleware({ scope })` names a shared authentication boundary. `createFileGenerateCache()` requires an explicit stable `scope` (or a fully partitioned custom `getKey`) before middleware reads or writes, preventing cross-tenant reuse and unreachable files across restarts. Never share a scope across credentials, tenants, or upstream base URLs.
- `createHttpTool()` propagates caller cancellation and idempotency, rejects redirects by default, validates its timeout, and bounds response bodies. Override `maxResponseBytes` or `redirect` only for an application-owned endpoint.
- `parseUIMessageRequest()` validates the runtime message/part shape and bounds request bytes, message count, and JSONL line size.
- The default browser WebSocket connection rejects oversized incoming frames. Set `maxIncomingFrameBytes` only when the provider contract requires a different bound.
- `assertTrustedEndpoint()` rejects credentials, unsafe schemes, private/loopback hosts, embedded private-IP DNS aliases, and allowlist boundary tricks unless a trusted server configuration explicitly opts in. Because it is synchronous, arbitrary DNS rebinding still requires an application-owned host allowlist plus resolver and egress controls.

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
