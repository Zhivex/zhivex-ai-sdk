# Examples

This folder contains runnable TypeScript examples for the main public surfaces of the Zhivex AI SDK.

## Layout

- `sdk/`: high-level SDK and core helpers
- `providers/`: one quick-start per provider package
- `gateway/`: routing and fallback examples
- `next-runner/`: copy-paste Next.js App Router reference for server-side Runner usage
- `_shared.ts`: tiny helpers used by the examples

## Run

From the repository root:

```bash
bun run examples/sdk/generate-text.ts
```

Most examples require provider credentials in environment variables. The files show which variables are needed.

Typical examples:

```bash
bun run examples/sdk/runner-session.ts
bun run examples/sdk/tools-with-safety-policy.ts
bun run examples/sdk/observability-export.ts
bun run examples/sdk/rag-agent.ts
bun run examples/sdk/stream-text.ts
bun run examples/sdk/agent-runtime.ts
bun run examples/sdk/agent-stream.ts
bun run examples/sdk/generate-object.ts
bun run examples/sdk/messages-and-tools.ts
bun run examples/sdk/transcribe-audio.ts
bun run examples/sdk/generate-speech.ts
bun run examples/sdk/grounded-text.ts
bun run examples/gateway/basic-routing.ts
bun run examples/gateway/stream-routing.ts
bun run examples/gateway/object-routing.ts
bun run examples/providers/openai.ts
```

The `examples/sdk/runner-session.ts` example is deterministic and does not require provider credentials. It is useful as a quick smoke for `Runner + SessionService`.

`examples/sdk/production-runner.ts` is a production template rather than a directly runnable script. It shows how to wire `Runner + createPostgresSessionService()` with an app-owned Postgres client without importing a database driver into the SDK.

`examples/sdk/observability-export.ts` is deterministic and does not require provider credentials. It shows how to collect an agent trace, compute cost/latency summaries, build tool-call audit records, and redact sensitive fields before a JSONL export.

`examples/sdk/rag-agent.ts` is deterministic and does not require provider credentials. It shows chunking, embedding, local ranking, context injection, and an agent run over retrieved context.

For migration-oriented snippets from direct provider SDKs, Vercel AI SDK core usage, and simple custom tool loops, see `docs/MIGRATION.md`. For RAG and semantic-memory recipes, see `docs/RAG.md`.

## Notes

- Most examples use the published package names such as `@zhivex-ai/sdk` and `@zhivex-ai/openai`.
- A few deterministic local examples import from the workspace source tree so they can run without provider credentials or a packed install.
- Some providers do not support every capability. The examples follow the actual adapter capabilities in this repo.
- `zod` is used in structured output and tool examples.
- Agent examples currently focus on the shared runtime, local tools, lifecycle streaming, and SSE/UI transport. Approval-based MCP flows are documented in the root `README.md` because they require a provider-specific remote MCP setup.
