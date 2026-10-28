# Experimental Apple Local bridge

Reference macOS helper for `@zhivex-ai/apple-local`. It is not published to npm. Linux CI does not compile it and does not run the on-device model.

The helper speaks the adapter's newline-delimited JSON protocol on stdin and stdout. Diagnostics go to stderr. One request is handled at a time, matching `LanguageModelSession.isResponding`.

```bash
swift run --package-path examples/apple-local-bridge
```

Build this on a Mac whose Xcode includes the macOS 26 SDK or newer. The executable target links `FoundationModels` and `AppKit`.

## What the helper calls

| Bridge request | Foundation Models API |
| --- | --- |
| `status` | `SystemLanguageModel.availability`, `contextSize`, `supportedLanguages`, `supportsLocale` |
| `generate` / `stream` | `LanguageModelSession.respond` or `streamResponse` |
| Tools | A `Tool` whose `parameters` are a runtime `GenerationSchema`. `call` records the arguments and throws so the TypeScript tool loop can execute them. |
| Guided generation | `respond(to:schema:includeSchemaInPrompt:options:)` |
| Sampling | `GenerationOptions.SamplingMode.greedy`, `random(probabilityThreshold:seed:)`, `random(top:seed:)` |
| Images | On macOS 27 and newer, `Attachment` inside a `Prompt` builder. Older systems return `unsupportedCapability`. |

Two spots are marked `CERTIFY` in `Sources/apple-local-bridge/main.swift` because Apple documents the types, while the enum case label or result-builder attachment still has to be confirmed against the SDK on the Mac:

- `Transcript.Segment.text(Transcript.TextSegment(...))`
- `Attachment(NSImage)` inside `Prompt`, from [WWDC26 session 241](https://developer.apple.com/videos/play/wwdc2026/241/)

Usage counters follow that session's `usage.input.totalTokenCount`, `usage.input.cachedTokenCount`, `usage.output.totalTokenCount`, and `usage.output.reasoningTokenCount` example. If those property names differ in the installed SDK, change `usagePayload` only.

Completed text responses use `finishReason: "stop"`. `Response` does not document a truncation flag, so this helper does not invent `length`.

## Tauri v2

Atlas local can wrap the same request handler as a Tauri v2 plugin instead of spawning this executable. Keep the Swift code on the native side. The webview only sees the JSON protocol.

1. Add a Swift plugin that calls the same `handle(line:)` path, or spawn `apple-local-bridge` and write one JSON line per request.
2. Register a command named `apple_local_request`. Its argument is `{ request }` and its result is an array of bridge messages (`event`, then a terminal `result` or `error`).
3. From TypeScript:

```ts
import { invoke } from "@tauri-apps/api/core";
import { createAppleLocal, createAppleLocalInvokeTransport } from "@zhivex-ai/apple-local";

const apple = createAppleLocal({
  transport: createAppleLocalInvokeTransport({
    invoke: (command, args) => invoke(command, args)
  })
});
```

4. Grant the plugin only to the app's own window. Do not expose the command to remote content. There is no API key. The model runs as the logged-in user, with that user's Apple Intelligence availability and guardrails.
5. Stream by returning `text-delta` events before the terminal result. Tauri's `Channel` can forward those events if a single `invoke` should not buffer the whole reply.

The plugin does not change `@zhivex-ai/core`. The adapter already accepts any transport that implements `send`.

## Live certification

Do this on a Mac. Do not add it to Linux CI.

1. Use a device where `SystemLanguageModel.default.availability` is `.available`. That requires Apple Intelligence hardware, an enabled setting, and a finished model download.
2. `swift run --package-path examples/apple-local-bridge` and leave the process in a terminal, or point `createAppleLocalStdioTransport` at `examples/apple-local-bridge/.build/debug/apple-local-bridge`.
3. From the repo, with Bun:

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createAppleLocal, createAppleLocalStdioTransport } from "@zhivex-ai/apple-local";

const apple = createAppleLocal({
  transport: createAppleLocalStdioTransport({
    command: "examples/apple-local-bridge/.build/debug/apple-local-bridge"
  })
});

console.log(await apple.availability());
console.log(await generateText({
  model: apple("apple-on-device"),
  prompt: "Reply with one short sentence."
}));
```

4. Confirm `availability().contextSize` against `SystemLanguageModel.contextSize` on that OS. The written guide says the system model supports up to 4,096 tokens. The WWDC26 session prints `8192` for the newer on-device model. The catalog therefore does not pin one number.
5. On macOS 27, repeat with a PNG user image and confirm the reply refers to the image. On macOS 26, the same call must fail with `unsupportedCapability` or the adapter's image-input error before a guess is shown.
6. Run one tool round trip and one `generateObject` schema. A machine with Apple Intelligence off must throw `appleIntelligenceNotEnabled` or `deviceNotEligible` and must not hang.
7. Record the OS version, `contextSize`, `supportedLanguages`, and whether image input was true. That note is the live evidence. This repository does not treat the mocked bridge tests as live certification.
