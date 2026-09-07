# Gateway canonical tool history delivery

Source: [SDK-HU in Notion](https://app.notion.com/p/3d4777b104f681c28f37d667aba649c2).

`GatewayInputMessage = GatewayMessage | ModelMessage` accepts canonical callable
history alongside legacy text/images. `generate`, `streamText`, `generateObject`
and `streamObject` preserve associations and reject invalid inputs before routing.
Agent operations remain legacy-only. See the [package guide](../packages/gateway/README.md#continuing-canonical-tool-history)
for the exact subset, format and capability contract.

## Provider support and verification — 2026-09-07

| Transport | Installed-tarball mock | Live generate + stream |
| --- | --- | --- |
| Anthropic Messages (`claude-sonnet-4-6`) | Passed | Passed with renewed credential, two calls, zero tool executions |
| OpenAI Chat (`gpt-4.1`) | Passed | Passed, two calls, zero tool executions |
| OpenAI Responses (`gpt-4.1`) | Passed | Passed, two calls, zero tool executions |
| DeepSeek Chat (`deepseek-chat`) | Passed | Passed, two calls, zero tool executions |
| Qwen Chat (`qwen-plus`) | Passed | HTTP 403 on first generation; requires model/account access |
| Qwen Responses (`qwen-plus`) | Passed | Not certified live |
| Qwen Chat (`qwen3.8-max`, `qwen3.8-flash`) | Regression tests passed | Passed, two calls per model, zero tool executions |
| Qwen Responses (`qwen3.8-max`, `qwen3.8-flash`) | Existing transport tests passed | Passed, two calls per model, zero tool executions |

Anthropic was retested on 2026-09-07 with the renewed credential using registry
adapter 0.9.0; generate and stream both returned real usage and finish reason
`stop`. This supersedes the previous HTTP 401 credential blocker.

The earlier Anthropic/OpenAI/DeepSeek live successes used the same candidate
tarball hashes as the six-route mock consumer. Qwen 3.8 runs use a corrected Qwen
tarball; the other five package hashes are unchanged. Both artifact sets remain
recorded separately in the evidence. Usage and finish reasons were validated, and the model's answer
used the supplied historical value. Prompts, outputs and credentials are not in
the evidence. Full SHA-512 identities and sanitized per-route results are in
[the machine-readable evidence](./GATEWAY_TOOL_HISTORY_EVIDENCE.json).

The isolated worktree passed typecheck, all 1,583 tests (84 gateway tests), a clean
build, documentation checks and strict compilation of the installed consumer.
Mock provider tests also cover multiple IDs/results, explicit errors,
error-shaped successful values, raw-format compatibility, cross-provider fallback,
no reexecution, private-thinking rejection, partial-stream failures and cache
separation between raw and envelope requests.

## Extensibility and compatibility

- Adapters opt in with `ModelCapabilities.toolHistory: "native" | "json"`.
  JSON adapters must honor low-level `ModelGenerateInput.toolResultFormat:
  "envelope"`, serializing all results with core `toolResultPayload()` as
  `{ output: value }` or `{ error: { message } }`. The gateway no longer needs
  a provider-name allowlist. Older Anthropic models retain their known native
  compatibility path; other older adapters without the declaration are skipped.
- OpenAI/DeepSeek/Qwen direct calls retain raw serialization by default; grouped
  tool results now produce all corresponding wire messages/items.
- DeepSeek/Qwen portable continuation defaults to non-thinking. Explicit thinking
  is rejected because the accepted history has no provider-private reasoning
  state. Thinking-only models are excluded. This avoids inventing or silently
  dropping the required state; see [DeepSeek's thinking contract](https://api-docs.deepseek.com/guides/thinking_mode/).
- JSON transports reject text interleaved after tool calls rather than moving it.
  Anthropic can preserve that ordering natively. Hosted/provider-native tools,
  provider-data and metadata are outside this portable input subset.
- Core owns the two optional contract fields. SDK now exports `ModelCapabilities`
  and `ModelGenerateInput` explicitly. No runtime dependency was added.

## Source and release boundaries

The original Anthropic-only commit is `24bed1b`. The extension is prepared on
`feat/gateway-canonical-tool-history` in `/private/tmp/zhivex-sdk-tool-history`;
the latest local commit is recorded in Notion. Changes are also synchronized to
the user's original checkout without replacing earlier unrelated work.

Push remains blocked by automatic permission review: explicit authorization to
upload the code/documentation to `Zhivex/zhivex-ai-sdk` is required. No retry,
remote branch, PR, merge, or publication is claimed.

Changesets cover core/SDK/gateway minor updates and OpenAI/DeepSeek/Qwen patches.
Current tarball manifest versions are **unpublished candidates**, not evidence
that registry versions already include this feature. Gateway currently declares
core `^1.11.0`; versioning must ship the new core/SDK contract and provider changes
together, update/review internal ranges and lockfile, and pass the protected
release workflow before Gateway API upgrades. Provider opt-in prevents an older
adapter from silently degrading a history request. GW-HU-09 remains open pending
published artifacts and its own endpoint acceptance.

## Reproduce

```bash
bun run docs:check
bun run typecheck
bun run test
bun run build
bun run scripts/gateway-history-package-smoke.ts
bun run scripts/gateway-history-package-smoke.ts --live --provider=anthropic
bun run scripts/gateway-history-package-smoke.ts --live --provider=openai
bun run scripts/gateway-history-package-smoke.ts --live --provider=openai --api=responses
bun run scripts/gateway-history-package-smoke.ts --live --provider=deepseek
bun run scripts/gateway-history-package-smoke.ts --live --provider=qwen
```

The consumer packs core, SDK, gateway and the three updated providers, installs
those tarballs plus registry Anthropic 0.9.0, and compiles with strict TypeScript
without workspace aliases or checkout links. Live runs require the corresponding
local credential; `ZHIVEX_GATEWAY_HISTORY_MODEL` selects an authorized model.
Missing credentials exit unsuccessfully. A successful mock run is not a live
certification. Live mode defaults to one transport per provider; `--api=responses`
selects the OpenAI/Qwen Responses path explicitly.


### Cross-provider continuation

Use the canonical `messages` from the gateway package guide with updated adapters:

```ts
import { createGateway } from "@zhivex-ai/gateway";
import { createOpenAI } from "@zhivex-ai/openai";
import { createDeepSeek } from "@zhivex-ai/deepseek";
import { createQwen } from "@zhivex-ai/qwen";

const gateway = createGateway({
  adapters: { openai: createOpenAI(), deepseek: createDeepSeek(), qwen: createQwen() }
});
const result = await gateway.generate({
  messages,
  primary: { provider: "openai", modelId: "gpt-4.1" },
  fallbacks: [
    { provider: "deepseek", modelId: "deepseek-chat" },
    { provider: "qwen", modelId: "qwen-plus" }
  ]
});
```

Do not share a provider-specific `apiMode` or thinking configuration across
incompatible destinations. With default options, each adapter chooses its own
supported transport. To run the optional Responses live smoke explicitly, use
`--live --provider=openai --api=responses` (or `--provider=qwen`).

## Qwen 3.8 live follow-up

Both `qwen3.8-max` and `qwen3.8-flash` passed generation and streaming on Chat
and Responses with the configured credential and standard international endpoint.
The models are listed in [Model Studio](https://help.aliyun.com/en/model-studio/models).
The previous `qwen-plus` HTTP 403 is model-specific evidence; its exact cause is
still unconfirmed and it does not establish a general credential failure.

The initial Chat runs returned HTTP 200 and correct answers, but usage was
estimated: the adapter discarded the separate usage-only chunk after
`finish_reason`. The fix defers the final event until the stream ends, preserving
real token usage as specified by [Qwen streaming documentation](https://help.aliyun.com/en/model-studio/stream).
Three regressions cover both models and EOF without a DONE marker. Full suite:
1,583 tests passed; typecheck, build and documentation checks passed. A Qwen patch
changeset is included. No new release or remote upload is implied.

Repeat each transport with `ZHIVEX_GATEWAY_HISTORY_MODEL=qwen3.8-max` or
`ZHIVEX_GATEWAY_HISTORY_MODEL=qwen3.8-flash`, followed by the consumer smoke
command with `--live --provider=qwen`; add `--api=responses` for Responses.
