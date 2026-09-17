# September 16 provider live certification

The evidence applies to locally built tarballs installed into an isolated Bun consumer, not to the existing npm releases with the same version numbers. Runs use synthetic prompts/media and existing provider credentials. They do not establish package-wide GA or production reliability.

## Reproduction

```bash
bun run build
ZHIVEX_WEEKLY_LIVE=1 bun run scripts/weekly-provider-live-certification.ts
```

This opt-in command makes billed API calls. Supply `DEEPSEEK_API_KEY`, `QWEN_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, and `OPENAI_API_KEY`. Qwen also accepts its existing region/base-URL/workspace configuration. `ZHIVEX_LIVE_CASE` selects a case by substring; `ZHIVEX_LIVE_REPORT` sets a new output path. Existing reports cannot be overwritten. Any failed case, empty selection, or cleanup failure produces a nonzero exit.

The runner records tarball and entry SHA-256 digests, base commit, tracked diff, fixture hash, root lockfile hash, timestamps, and allowlisted usage/events. Tarball digests cover untracked implementation files included in the build; the tracked diff digest alone does not. Packed packages retain pre-versioning package versions. Temporary consumers and tarballs are removed after execution.

Calls have deadlines and no automatic provider retries. Managed Anthropic sessions have a USD 1 list-cost budget and outbound networking disabled. Cleanup deletes test sessions/environments and archives Anthropic agent definitions (the native API exposes archive, not delete). No credential values, audio bytes, signed compaction blocks, or model thoughts are stored.

## Scope

| Surface | Assertions |
| --- | --- |
| DeepSeek direct | Synthetic image color on `deepseek-flash`, `deepseek-v4-flash`, and `deepseek-v4-flash-vision-exp` |
| Qwen-hosted DeepSeek | Text generation on `deepseek-v4.1-flash`; separate API route |
| Gemini 3.8 Live | One tool call/result, matching transcript, nonempty audio, completion |
| Gemini 3.8 Live Extended Thinking | Same cycle plus `IN_PROGRESS` / `IDLE` lifecycle evidence |
| Anthropic compaction | Signed summary, usage, and replay preserving an agreed entity; generate and stream |
| OpenAI Agents | Create/stream/retrieve/items/delete, event submission, explicit turn cancellation |
| Anthropic Managed Agents | `auto` allows a tool, matching successful result and response, idle, cleanup |

OpenAI uses `gpt-6-astra` with `environment.type: "none"`; no hosted sandbox or remote tools are certified. Anthropic uses `claude-opus-5`. Gemini exercises text-to-tool-to-audio, not microphone input or voice quality. DeepSeek/Qwen tests do not certify every tool, structured-output, file, or streaming combination.

## Findings and attempt history

Initial evidence is retained, including failures; a later pass does not erase earlier outcomes.

- [Initial run](../evidence/weekly-provider-live-2026-09-16.json): Gemini Extended Thinking reached the 55-second deadline. Its [isolated recheck](../evidence/weekly-provider-live-2026-09-16-gemini-recheck.json) completed with `IDLE`; no protocol change was needed for that recheck.
- The first compaction fixture exposed a local assistant-prefill rejection. The adapter now permits a completed assistant turn when explicitly summarizing; ordinary generation still rejects unsupported prefills. A [custom synthetic-reference prompt returned refusal](../evidence/weekly-provider-live-2026-09-16-compaction-diagnostic.json); it is not counted as success. The [recipe-history case](../evidence/weekly-provider-live-2026-09-16-compaction-final.json) passed summary and replay.
- The [Anthropic stream run](../evidence/weekly-provider-live-2026-09-16-anthropic-final.json) passed both compaction modes but exposed a test-cleanup error: agent definitions require `archive`. [Recovery evidence](../evidence/weekly-provider-live-2026-09-16-cleanup.json) confirms both affected definitions were archived. The [complete managed-agent recheck](../evidence/weekly-provider-live-2026-09-16-managed-final.json) passed tool-result, idle, and cleanup assertions.
- The [OpenAI cancellation diagnostic](../evidence/weekly-provider-live-2026-09-16-openai-cancel-diagnostic.json) exposed empty HTTP 202 acknowledgements on event submission. The native client now accepts those acknowledgements instead of attempting to parse empty JSON, with a regression test. An earlier fixture also established that conversation-only session creation requires initial input.

## Final result

[Consolidated evidence](../evidence/weekly-provider-live-2026-09-16-consolidated.json): **11/11 cases passed**, September 16, 2026, 21:10–21:11 ART (September 17, 00:10–00:11 UTC). No cleanup errors remained in that run. Earlier leaked test definitions were archived as shown in the recovery report. All seven recorded entry hashes match the final local build.

The DeepSeek service returned `deepseek-flash` for all three requested aliases. Gemini Extended Thinking emitted `IN_PROGRESS`, then `IDLE`, and completed exactly one tool cycle. OpenAI accepted both message submission and cancellation with empty HTTP 202 responses; the event stream confirmed `agent.session.turn.cancelled`. Anthropic confirmed a matching successful tool result, final response, and idle state before cleanup.

Local validation: `bun run docs:check`, `bun run typecheck`, `bun run build`, `bun run test` (1,838 tests / 132 files), `git diff --check`, and the secret scan passed. A separate check found no configured credential values in the evidence files. The live opt-in guard was also verified to fail before network activity when unset.

The runner and evidence are ready for review. These changes are not committed, pushed, versioned, or published. A release must certify its own immutable, newly versioned artifacts; this report does not certify existing npm bytes or imply a package-wide stability promotion.
