# Apple on-device provider

`@zhivex-ai/apple-local` calls Apple's on-device system language model through a local bridge. The TypeScript adapter does not link Foundation Models and does not take an API key. A Mac running the reference helper, or a Tauri v2 plugin that speaks the same JSON protocol, performs the Swift calls.

The package is experimental. Linux CI tests it with a mock bridge. Live certification is a Mac-only procedure and has not been run for this change.

## What Apple documents

Sources are Apple Developer documentation and WWDC sessions on developer.apple.com.

| Capability | On-device `SystemLanguageModel` | Adapter |
| --- | --- | --- |
| Text generation | `LanguageModelSession.respond(to:options:)` | `generate` |
| Streaming | `streamResponse` yields partial snapshots | `stream` |
| Instructions | Session instructions outrank the prompt | Leading system messages |
| Tools | `Tool`, including parallel calls | Callable tools. The bridge returns tool calls for the SDK loop |
| Tool mode | `ToolCallingMode` `allowed`, `required`, `disallowed` | `toolChoice` `"auto"`, `"required"`, `"none"` |
| Named tool choice | Not documented | Rejected |
| Guided generation | `@Generable`, `GenerationSchema`, `DynamicGenerationSchema` | `generateObject` native mode, for a JSON Schema subset |
| JSON mode without a schema | Not documented | `jsonMode: false` |
| Sampling | `greedy`, nucleus `random(probabilityThreshold:seed:)` (documented as top-p), `random(top:seed:)` | `topP`, `seed`, `providerOptions.sampling` |
| Temperature and output cap | `GenerationOptions.temperature`, `maximumResponseTokens` | `temperature`, `maxTokens` |
| Stop sequences | Not documented | Ignored by the shared sampling warning |
| Context | Guide: up to 4,096 tokens. `contextSize` is the live value and can throw if the model is unavailable. WWDC26 prints `8192` for the newer on-device model | `availability().contextSize`. The catalog does not pin one number |
| Availability | `available`, or `unavailable` with `deviceNotEligible`, `appleIntelligenceNotEnabled`, `modelNotReady` | `apple.availability()` and the same errors before generation |
| Languages | `supportedLanguages`, `supportsLocale`. The language list is the Apple Intelligence list and changes with OS updates | `providerOptions.locale` |
| Guardrails | Default checks, plus `permissiveContentTransformations` for string generation only | `providerOptions.guardrails` |
| Images | WWDC26: the on-device model gains image attachments. `ImageReference.resolve` is marked macOS 27 | Sent only when the bridge reports `imageInput: true` |
| Reasoning | Documented on Private Cloud Compute via `reasoningLevel`, not as an on-device request parameter | Rejected |
| Embeddings, audio, files, web search, hosted tools, prompt caching | Not part of this on-device text model | Capability flags are off and direct calls fail |
| Rate limits | `LanguageModelError.rateLimited` includes an optional `resetDate`. No published request quota | `AppleLocalError` code `rateLimited` and `retryAt` |
| Price | No token price. The model runs on device, including offline | Catalog cost `0` |

Model versions listed on `SystemLanguageModel` line up with OS 26.0–26.3, OS 26.4, and OS 27.0. The framework is for macOS, iOS, iPadOS, and visionOS. This bridge is a macOS executable. Supported devices are whatever Apple Intelligence supports; the availability API is the check, and `deviceNotEligible` is the failure when the device is not.

## Use

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createAppleLocal, createAppleLocalStdioTransport } from "@zhivex-ai/apple-local";

const apple = createAppleLocal({
  transport: createAppleLocalStdioTransport({
    command: "apple-local-bridge"
  })
});

const availability = await apple.availability();
const result = await generateText({
  model: apple("apple-on-device"),
  prompt: "Summarize this note in one sentence."
});
```

`apple-on-device` is `SystemLanguageModel.default` (use case `general`). Aliases: `system`, `general`. `apple-on-device-content-tagging` selects the `contentTagging` use case. Alias: `content-tagging`.

The reference helper and the Tauri v2 notes are in [examples/apple-local-bridge](../examples/apple-local-bridge/README.md). Package usage is in [packages/apple-local](../packages/apple-local/README.md).

## Bridge

The transport is injected. `createAppleLocalStdioTransport` runs the helper. `createAppleLocalInvokeTransport` calls a Tauri command named `apple_local_request`. Tests pass a fake `send` implementation. The protocol version is `1`: one JSON object per line, with `status`, `generate`, and `stream`.

Tool calls are returned to the SDK. The Swift tool records the model's arguments and throws, because `Tool.call` otherwise runs inside `respond` before the TypeScript tool loop can see them. The next turn rebuilds a `Transcript` with `ToolCall` and `ToolOutput`. A turn that ends in tool results calls `respond` with an empty prompt. Apple's public session API has no continue-without-a-prompt method. Live certification has to confirm that empty continuation.

## Live certification

Run this on a Mac with Apple Intelligence available. It is not part of Linux CI.

1. Build `examples/apple-local-bridge` with Xcode that includes the macOS 26 SDK or newer.
2. Call `apple.availability()` and record `contextSize`, `supportedLanguages`, and `imageInput`.
3. Generate a short sentence, stream it, run one tool round trip, and run one native object schema.
4. Repeat an image prompt only if `imageInput` is true.
5. On a machine where Apple Intelligence is off or unsupported, confirm the error is `deviceNotEligible`, `appleIntelligenceNotEnabled`, or `modelNotReady`.

Confirm the two `CERTIFY` lines in the Swift helper against the installed SDK: the `Transcript.Segment` text case, and `Attachment(NSImage)` inside a prompt. Those are the only call sites that go beyond a documented initializer into a case label or result-builder shape shown in the WWDC session.

## Primary links

- [Foundation Models](https://developer.apple.com/documentation/foundationmodels)
- [SystemLanguageModel](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel)
- [Generating content](https://developer.apple.com/documentation/foundationmodels/generating-content-and-performing-tasks-with-foundation-models)
- [Tool calling](https://developer.apple.com/documentation/foundationmodels/expanding-generation-with-tool-calling)
- [Guided generation](https://developer.apple.com/documentation/foundationmodels/generating-swift-data-structures-with-guided-generation)
- [GenerationOptions](https://developer.apple.com/documentation/foundationmodels/generationoptions)
- [Sampling nucleus / top-p](https://developer.apple.com/documentation/foundationmodels/generationoptions/samplingmode-swift.struct/random(probabilitythreshold:seed:))
- [contextSize](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/contextsize)
- [Availability reasons](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/availability-swift.enum/unavailablereason)
- [Languages](https://developer.apple.com/documentation/foundationmodels/supporting-languages-and-locales-with-foundation-models)
- [Guardrails](https://developer.apple.com/documentation/foundationmodels/improving-the-safety-of-generative-model-output)
- [LanguageModelError, including rate limits](https://developer.apple.com/documentation/foundationmodels/languagemodelerror)
- [What's new in Foundation Models, WWDC26](https://developer.apple.com/videos/play/wwdc2026/241/)
- [Apple Intelligence](https://developer.apple.com/apple-intelligence/)
