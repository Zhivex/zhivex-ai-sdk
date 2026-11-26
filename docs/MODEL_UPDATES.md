# Model and provider updates

Dated notes on catalog and adapter changes. Package READMEs hold the full setup for each provider. Release notes for every version are on [GitHub Releases](https://github.com/Zhivex/zhivex-ai-sdk/releases).

## November 2026 provider alignment

The release-managed catalog includes GLM FlashX/Legal and Qwen TTS 3.1, current
Meta Spark prices, GPT-5.6 Sol promotional cache/input/output rates, and Gemini
3.8 Flash pricing. Optional `ModelCatalogEntry.pricingTerms` records verified
promotion dates and source notes. `validThrough` means a confirmed end date;
`guaranteedThrough` means a minimum promised duration, not an automatic expiry.
Catalog snapshots remain immutable and never switch to future prices by clock.
Review promotions after those dates before relying on estimates. Meta
Contributor variants require permission to use content for training; their
catalog prices do not opt in or replace Standard IDs.

Provider packages also expose explicit Anthropic message-thread controls,
DeepSeek Search/Fetch, and Meta's native computer protocol. Gemini GenerateContent
routes now default to `store: false`; consumers that intentionally want request
logging must pass `providerOptions.store: true`. See the individual package
READMEs for privacy, route, and compatibility details.

## November 2026 model updates

The SDK catalog includes Claude Fable 5.2 / Mythos 5.2, Gemini 4 Carbon / Hydrogen, and
Gemini Omni 1.2 Flash. Claude 5.2 uses always-on adaptive thinking, rejects forced
tools, and requires a 5.2 advisor. Preserve signed thinking blocks and the preceding
conversation unchanged; prefix checks are enforced by Anthropic. Explicit
`thinking.block_binding.prefix_mismatch_behavior: "drop_block"` opts into the
provider's beta fallback. Fast mode uses `speed: "fast"` without a fast-mode beta.
Mythos access remains restricted by the provider.

Carbon uses `low`, `medium`, or `high` thinking and implicit caching only. Its
catalog records the 65,536-token synchronous output limit; larger outputs require
background long decode. Introductory token prices expire November 30, 2026;
future rates are documented but never activated automatically.

Neon (`gemini-4-neon`) is available through the paid Gemini API and on
Vertex (`global`, `us`, or `eu`). Both adapters accept `low`, `medium`, `high`,
and `xhigh` reasoning. Set `maxTokens` above 65,536 to allow a long decode
across multiple segments within the shared 1,048,576-token context window.
The adapters follow the provider's checkpoints and report usage across segments.
See the [Gemini adapter](../packages/gemini/README.md#gemini-4-neon) and
[Vertex adapter](../packages/vertex/README.md#gemini-4-neon).

Hydrogen (`gemini-4-hydrogen`) is supported by Gemini and Vertex with
`reasoning: { effort: "xhigh" }`, alongside `low`, `medium`, and `high`.
Omitting effort preserves the provider default (`high`). It uses implicit caching
only and provider-managed sampling; the adapters reject explicit caches, thinking
budgets, `minimal`/`none`, sampling controls, and assistant prefill.
The catalog records a shared 1,048,576-token context and 65,536 tokens per foreground
segment. For longer output, use Interactions background execution with
`generationConfig: { thinking_level: "xhigh", max_output_tokens: 100000 }`.
Vertex supports `global`, `us`, and `eu`; catalog prices describe Standard global
inference ($1.50 input, $0.075 cached input, $7.50 output per million tokens).
Non-global Vertex prices are 10% higher. Future cache-write fees are not applied.
See [thinking levels](https://aistudio.google.com/docs/thinking) and the
[Vertex Hydrogen guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-hydrogen).

Use `gemini.interactions.create` with `modelId: "gemini-omni-1.2-flash"` for video.
Set `responseFormat: { type: "video", duration: "15s" }` for up to 15 seconds.
Interpolation and extension remain limited to 10 seconds per turn; the service
validates these prompt-dependent modes. Omni 1.1 automatically routes to 1.2 from
December 3, 2026. These additions have mocked contract coverage, not live certification.

Sources: [Claude 5.2 migration](https://platform.claude.com/docs/en/models/fable-5-2/whats-new-fable-5-2),
[Carbon](https://aistudio.google.com/docs/whats-new-gemini-4-carbon),
[Omni](https://aistudio.google.com/docs/omni).

