# Qwen Cloud support

This document distinguishes implemented contracts from authenticated observations. Catalog discovery alone is not certification of an account, model or transport. Existing Model Studio endpoints remain the default for compatibility; select Qwen Cloud explicitly:

```ts
import { createQwen, QWEN_CLOUD_BASE_URL, QWEN_DECISION_PREVIEW_BASE_URL } from "@zhivex-ai/qwen";

const qwen = createQwen({
  apiKey: process.env.QWEN_API_KEY,
  baseURL: QWEN_CLOUD_BASE_URL,
  decisionBaseURL: QWEN_DECISION_PREVIEW_BASE_URL
});
```

HTTP task and WebSocket hosts follow the configured base host. A custom `realtimeURL` remains supported; binary speech inference uses its `/inference` sibling, or an explicit `inferenceURL` for custom gateway routes. Dedicated Token Plan credentials are not a replacement for standard Cloud credentials.

## APIs

| Surface | SDK entry point | Contract |
| --- | --- | --- |
| Text, tools, vision | `qwen(modelId)` | Existing Chat/Responses paths; new dated Max alias and open-model vision |
| Character and machine translation | `qwen("qwen-flash-character")`, `qwen("qwen-mt-lite")` | Text-only guardrails; MT single-user Chat requests and cumulative-to-incremental streaming for Plus/Turbo |
| Decision | `qwen.decisionModel().decide()` | Typed `choice`, `noul`, `score`; exact probability/confidence validation; explicit preview endpoint |
| Dense embeddings | `qwen.embeddingModel!(id).embed()` | Dimensions, ordered results and model batch limits |
| Native embeddings | `qwen.textEmbeddingModel(id).embedNative()` | Query/document instructions and dense/sparse outputs |
| Speech synthesis | `qwen.speechModel!(id).generateSpeech()` | Cloud Audio TTS uses JSON control and binary audio over inference WebSocket |
| Streaming ASR | `qwen.streamingASRModel(id)` | Binary input, partial/final transcripts; also available through `transcriptionModel` for bounded complete input |
| Synchronous ASR | `qwen.transcriptionModel!("qwen-audio-3.0-asr-flash")` | Native multimodal HTTP route |
| File ASR | `qwen.fileTranscriptionModel(id)` | Explicit submit/get; per-file success/failure; no automatic fetch of signed transcript URLs |
| Realtime | `qwen.realtimeModel(id).connect()` | Audio/Omni model profiles over WebSocket; typed Cloud options and MCP approval extension |
| Browser / native RTC | `connectQwenWebRTC`, `createQwenSDPExchange`, `connectQwenAOQ` | Browser SDP/media lifecycle and an injected official native AOQ engine; optional `@zhivex-ai/qwen/browser` entry point |
| Images | `qwen.imageGenerationModel!(id)` | Image 3.0 generation/editing with validated options |
| Video | `qwen.videoGenerationModel!(id)` | Asynchronous tasks, model-specific media mapping; retrieve completion through `qwen.tasks` |
| Image translation | `qwen.imageTranslationModel().translate()` | Native synchronous/asynchronous translation |
| Worlds | `qwen.worlds(id)` | HappyOyster lifecycle and interaction APIs; browser RTC uses an explicit official-SDK bridge |

Specialty IDs are rejected through the language-model factory with an actionable error. Public Qwen extensions and types are exported by `@zhivex-ai/qwen`; shared helpers and the catalog remain available from `@zhivex-ai/sdk`.

Additional guides: [audio/realtime](./QWEN_CLOUD_AUDIO.md), [embeddings](./QWEN_CLOUD_EMBEDDINGS.md), [media/worlds](./QWEN_CLOUD_MEDIA.md).

For browser clients, issue short-lived credentials on the backend with `qwen.temporaryKeys.create({ expiresInSeconds: 60 })`. The result contains `token` and `expiresAt` (Unix seconds); the token inherits the issuing key's permissions. The optional `createQwenWorldRTC` bridge accepts the official browser SDK factory and temporary key. It preserves the native Travel type and handles failed-start cleanup; the browser application owns rendering and event listeners.

## Decision example

```ts
const result = await qwen.decisionModel().decide({
  state: { ticket: "The customer requests a refund." },
  questions: {
    team: { type: "choice", instructions: "Select the team.", criteria: {
      billing: "Payments and refunds", technical: "Product faults"
    } },
    urgent: { type: "noul", instructions: "Does the issue require urgent attention?" },
    severity: { type: "score", instructions: "Assess severity.", criteria: ["Minor", "Major", "Critical"] }
  },
  maxRetries: 0,
  timeoutMs: 15_000
});
// Application policy chooses thresholds; the SDK preserves probabilities.
console.log(result.answers.team.choice, result.answers.urgent.noul);
```

See [Decision contract and measured comparison](./QWEN_CLOUD_DECISION.md) and [native ASR](./QWEN_CLOUD_ASR.md).

## Cost-conscious validation

Live tests are opt-in and use synthetic short prompts/audio, zero inference retries, minimal dimensions and bounded timeouts. Unit tests never need credentials. Availability failures must be reported as failures, not converted into passing tests. Monetary totals require billing data; token counts are not treated as prices.

On September 26, 2026, the three-request text smoke passed: two short strings using `qwen3.7-text-embedding` at 256 dimensions, one greeting through `qwen-mt-lite`, and a 16-token response budget with thinking disabled through `qwen3.8-27b`.

```bash
QWEN_CLOUD_TEXT_INTEGRATION=1 \
QWEN_BASE_URL=https://maas.qwencloudapi.com/compatible-mode/v1 \
bun --env-file=.env run test:integration packages/qwen/tests/cloud-text.integration.test.ts
```

This validates those operations only; it does not establish complete live certification for all models or browser transports. Existing [Omni HTTP evidence](./QWEN_OMNI_FLASH_LIVE.md) remains dated evidence for that exact model.

## Sources

- [Model releases](https://docs.qwencloud.com/changelog/models)
- [Decision API](https://docs.qwencloud.com/api-reference/decision-model-api)
- [Embedding guide](https://docs.qwencloud.com/developer-guides/embeddings/embedding)
- [Machine translation](https://docs.qwencloud.com/developer-guides/text-generation/qwen-mt)
- [Realtime multimodal API](https://docs.qwencloud.com/api-reference/real-time-multimodal/client-events)
