# Gateway canonical tool history delivery — historical record

Evidence snapshot: 2026-09-07. This report preserves the scope and results of that
delivery. It is not current release status, provider availability, or an adoption
guide. Model IDs and package versions below identify the historical checks.
For current usage, see the [Gateway package guide](../../packages/gateway/README.md#continuing-canonical-tool-history).

Source: [SDK-HU in Notion](https://app.notion.com/p/3d4777b104f681c28f37d667aba649c2).

`GatewayInputMessage = GatewayMessage | ModelMessage` accepts canonical callable
history alongside legacy text/images. `generate`, `streamText`, `generateObject`
and `streamObject` preserve associations and reject invalid inputs before routing.
At the time of this delivery, agent operations remained legacy-only. The package
guide above describes the current subset, format and capability contract.

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
[the machine-readable evidence](../GATEWAY_TOOL_HISTORY_EVIDENCE.json).

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

## Historical source and release boundaries

The original Anthropic-only commit was `24bed1b`. This delivery's validation used
candidate tarballs; their manifest versions and hashes do not establish npm
publication. The report did not certify a merge, protected release, or downstream
Gateway API acceptance. Provider opt-in prevents an older adapter from silently
degrading a history request.

For current publication procedures and verification, use the
[release guide](../maintainers/RELEASE.md). The local worktree, permission blockers,
and pending-task status from the original delivery are not current release gates.

## Historical verification commands

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

At the time of verification, the consumer packed core, SDK, gateway and the three
updated providers, installed those tarballs plus registry Anthropic 0.9.0, and
compiled with strict TypeScript
without workspace aliases or checkout links. Live runs require the corresponding
local credential; `ZHIVEX_GATEWAY_HISTORY_MODEL` selects an authorized model.
Missing credentials exit unsuccessfully. A successful mock run is not a live
certification. Live mode defaults to one transport per provider; `--api=responses`
selects the OpenAI/Qwen Responses path explicitly.


### Current continuation examples

Use the [Gateway package guide](../../packages/gateway/README.md#continuing-canonical-tool-history)
for maintained examples. The original example used `deepseek-chat` and
`qwen-plus`; those historical IDs are retained in the evidence table, not as
current model recommendations.

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
changeset accompanied that delivery. These results do not establish publication.

Repeat each transport with `ZHIVEX_GATEWAY_HISTORY_MODEL=qwen3.8-max` or
`ZHIVEX_GATEWAY_HISTORY_MODEL=qwen3.8-flash`, followed by the consumer smoke
command with `--live --provider=qwen`; add `--api=responses` for Responses.
