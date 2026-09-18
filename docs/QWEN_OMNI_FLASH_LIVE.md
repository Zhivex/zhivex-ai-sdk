# Qwen3.8-Omni-Flash HTTP validation

Validated on 2026-09-18 UTC against `qwen3.8-omni-flash` at
`https://dashscope-intl.aliyuncs.com/compatible-mode/v1`, using the local Qwen
credential without logging its value. Requests used public Alibaba sample media.

## Implemented contract

- Chat Completions and Responses, streaming and non-streaming.
- Text/image/audio/video inputs; HTTP text output only.
- Hybrid reasoning with seven shared effort values, Chat aliases and preserved
  reasoning history, and mutually exclusive effort/budget controls.
- Callable tools and hosted Responses `web_search`; other hosted tools rejected.
- Prompted structured output with local Zod validation. Native structured output
  remains unadvertised pending a verified model-specific contract.
- SDK-owned model catalog entry and published input/output/cache token rates.

Sources: [QwenCloud model card](https://www.qwencloud.com/models/qwen3.8-omni-flash),
[official Omni guide](https://www.alibabacloud.com/help/en/model-studio/qwen-omni).

## Live evidence

All 12 distinct scenarios were verified across the initial run and focused rerun:

| Scenario | Chat | Responses |
| --- | --- | --- |
| Non-streaming text and nonzero usage | Passed | Passed |
| Streaming reasoning, answer and final usage | Passed | Passed |
| Combined image/audio semantic understanding | Passed | Passed |
| Public video understanding and usage | Passed | Passed |
| Callable tool execution and final answer using its result | Passed | Passed |
| Prompted JSON with schema validation | — | Passed |
| Hosted web search, returned sources and response continuation | — | Passed |

The initial run had 10 passing tests and two assertion failures:

- Image/audio: the answer correctly identified a Labrador retriever and
  transcribed “Welcome to Alibaba Cloud”, but the assertion required the word
  “dog”. The assertion now accepts the semantically equivalent breed names.
- Hosted web search: with `toolChoice: "required"`, upstream returned
  `status: "completed"` and a completed `web_search_call` with sources, but no
  final text. The test now validates the actual search item and sources, then
  explicitly continues the response to obtain a final answer. Both steps passed.

The focused rerun passed all three selected cases (image/audio on both APIs and
hosted search); nine cases were intentionally filtered out, not credential-skipped.
No provider implementation change was needed for those assertion corrections.

## Local checks

- Qwen and SDK catalog: **113 tests passed across four files**.
- `bun run typecheck`, `bun run build`, and `bun run docs:check`: passed.
- `bun pm pack --dry-run` in `packages/qwen`: passed, 10 publishable files.
- Initial full suite: 1,877 tests passed. After adding four further regression
  cases, the final full suite had **1,880 passed and one failed**: the React
  declaration snapshot (`packages/core/tests/api-type-snapshot.test.ts`) differed
  due to concurrent React changes, outside this Qwen implementation.
- `bun run release:check` reached npm and confirmed existing package versions,
  then stopped at the expected requirement for a committed, clean release source.

No commit, push, versioning or publication was performed. The Qwen and SDK
changeset is ready for the normal release workflow.

## Reproduce

```bash
QWEN_OMNI_INTEGRATION=1 bun --env-file=.env run test:integration packages/qwen/tests/omni-flash.integration.test.ts --reporter=verbose
bun run test packages/qwen/tests packages/sdk/tests/catalog.test.ts
```

The suite fails if explicitly enabled without a credential. Optional endpoint
selection uses `QWEN_BASE_URL`, `QWEN_WORKSPACE_ID`, and `QWEN_REGION`.

This evidence covers the Singapore HTTP route only. It does not certify other
regions, the separate Realtime model, WebRTC, maximum context limits, spatial
audio quality, native JSON Schema, or published npm artifact behavior. Binary
media and multichannel request mapping are covered by local transport tests;
live media checks used public URLs.
