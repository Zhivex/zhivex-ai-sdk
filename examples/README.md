# Examples

This folder contains runnable TypeScript examples for the main public surfaces of the Zhivex AI SDK.

## Layout

- `sdk/`: high-level SDK and core helpers
- `providers/`: one quick-start per provider package
- `gateway/`: routing and fallback examples
- `_shared.ts`: tiny helpers used by the examples

## Run

From the repository root:

```bash
bun run examples/sdk/generate-text.ts
```

Most examples require provider credentials in environment variables. The files show which variables are needed.

Typical examples:

```bash
bun run examples/sdk/stream-text.ts
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

## Notes

- Examples use the published package names such as `@zhivex-ai/sdk` and `@zhivex-ai/openai`.
- Some providers do not support every capability. The examples follow the actual adapter capabilities in this repo.
- `zod` is used in structured output and tool examples.
