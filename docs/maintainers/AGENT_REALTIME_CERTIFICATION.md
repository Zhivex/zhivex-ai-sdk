# Realtime And Live Agent Certification

`streamLiveAgent`, raw realtime sessions, and their shared lifecycle helpers are
Stable. This document defines the release evidence that protects that contract;
provider model IDs and upstream preview availability remain provider-scoped.

## Live Gate

Put the provider credentials in the repository `.env` without printing or
copying them into logs:

- `GEMINI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY`
- `QWEN_API_KEY` or `DASHSCOPE_API_KEY`
- `OPENAI_API_KEY`

Then run:

```bash
bun --env-file=.env run test:integration:agents-realtime
```

The script activates `ZHIVEX_LIVE_AGENT_CERTIFICATION=1`. If the flag is absent,
the integration file skips during broad local integration runs. If the flag is
present, missing credentials are fatal and no provider is silently omitted.
Secrets are never included in success or failure messages.

Current default realtime models are:

| Provider | Default | Optional override |
| --- | --- | --- |
| Gemini | `gemini-3.1-flash-live-preview` | `ZHIVEX_LIVE_AGENT_GEMINI_MODEL` |
| Qwen | `qwen3.5-omni-plus-realtime` | `ZHIVEX_LIVE_AGENT_QWEN_MODEL` |
| OpenAI | `gpt-realtime` | `ZHIVEX_LIVE_AGENT_OPENAI_MODEL` |

Endpoint and workspace overrides continue to use the provider variables already
documented by their packages: `GEMINI_BASE_URL`, `GEMINI_REALTIME_URL`,
`QWEN_BASE_URL`, `QWEN_TASK_BASE_URL`, `QWEN_REALTIME_URL`,
`QWEN_WORKSPACE_ID`, `QWEN_REGION`, `OPENAI_BASE_URL`, and
`OPENAI_REALTIME_URL`. The per-provider deadline defaults to 45 seconds;
`ZHIVEX_AGENT_REALTIME_TIMEOUT_MS` may set an integer from 1000 through 120000
for an explicitly reviewed environment.

The Qwen leg intentionally uses the provider's fail-closed realtime contract:
callable tools use automatic selection, while `toolChoice: "none"` is enforced
locally by omitting tools. `"required"`, named-tool selection, and
`providerOptions.enable_search: true` combined with callable tools are rejected
before the WebSocket opens. Qwen output defaults to `modalities: ["text"]`;
audio output is requested only when `voice` or `outputAudioMediaType` is set.

For each provider the gate must prove:

1. `streamLiveAgent()` opens a real provider session through the public adapter.
2. The provider requests `certify_live_once` and the local tool executes exactly
   once with a valid input.
3. The tool result is returned to the provider and the agent receives a non-empty
   post-tool response.
4. Normalized realtime, tool-call, response-complete, and agent lifecycle events
   are observable.
5. The session closes before the 45-second deadline.

Any provider failure fails the whole command. Record the checkout commit, date,
provider/model matrix, command result, and any upstream account limitations when
preserving certification evidence. Do not describe fixture-only or skipped runs
as live certification.

## Installed Tarball Gate

Run the deterministic package consumer after building the release source:

```bash
bun run smoke:packages
```

This packs and installs all publishable packages into an isolated consumer. The
consumer imports `@zhivex-ai/core`, `@zhivex-ai/sdk`, and
`@zhivex-ai/agents/realtime`, constructs a public `CallbackRealtimeSession`,
executes `streamLiveAgent`, emits a tool call followed by the provider's initial
response-complete event, verifies one local execution and one returned tool
result, then requires a non-empty post-tool response and connection closure. It
is offline and deterministic; it proves packaged entrypoints, continuation, and
composition, not provider availability.

## Stable Release Checklist

Do not ship a realtime/live change until all of the following are reviewed together:

- the three-provider live gate passes without skips on the immutable release
  source;
- the installed-tarball deterministic smoke passes on the same source;
- provider/model IDs and upstream preview status are recorded explicitly;
- tool-call continuation, post-tool output, timeout, error, and closure behavior
  have regression coverage;
- public realtime/live types and entrypoint placement have a compatibility
  decision and migration notes;
- compatibility changes have documentation, declaration snapshots, a changeset,
  and release evidence in one reviewed change.

The Stable classification applies to the shared runtime contract, not to a
promise that every provider will keep every preview model available.

## Latest Local Evidence

On 2026-08-15, the implementation checkout passed the live gate 3/3 without
skips using `gemini-3.1-flash-live-preview`,
`qwen3.5-omni-plus-realtime`, and `gpt-realtime`. The same checkout passed the
installed-package smoke with 27 public entrypoints and the
`INSTALLED_REALTIME_LIVE_SMOKE_OK` marker. This is pre-commit implementation
evidence; release operators must repeat both gates on the immutable release
commit before publishing.
