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

## Recorded result

On September 16, 2026, the consolidated local installed-tarball run passed **11/11 cases** with no cleanup errors. This is historical evidence, not current certification, npm publication or a stability promotion. Earlier failures remain available below.

The narrative findings and attempt history are in the [internal historical archive in Notion](https://www.notion.so/418777b104f681a089c1c27e90679725). Public evidence and reproduction remain in this repository.

## Evidence

- [Initial run](../evidence/weekly-provider-live-2026-09-16.json)
- [isolated recheck](../evidence/weekly-provider-live-2026-09-16-gemini-recheck.json)
- [custom synthetic-reference prompt returned refusal](../evidence/weekly-provider-live-2026-09-16-compaction-diagnostic.json)
- [recipe-history case](../evidence/weekly-provider-live-2026-09-16-compaction-final.json)
- [Anthropic stream run](../evidence/weekly-provider-live-2026-09-16-anthropic-final.json)
- [Recovery evidence](../evidence/weekly-provider-live-2026-09-16-cleanup.json)
- [complete managed-agent recheck](../evidence/weekly-provider-live-2026-09-16-managed-final.json)
- [OpenAI cancellation diagnostic](../evidence/weekly-provider-live-2026-09-16-openai-cancel-diagnostic.json)
- [Consolidated evidence](../evidence/weekly-provider-live-2026-09-16-consolidated.json)
