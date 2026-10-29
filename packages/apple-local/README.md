# @zhivex-ai/apple-local

Experimental adapter for Apple's on-device system language model. Generation runs through an injected local bridge. There is no API key and no cloud request.

The reference macOS helper and Tauri v2 notes are in `examples/apple-local-bridge`. Linux tests use a mock bridge. See [the provider guide](../../docs/APPLE_LOCAL.md) for Apple's documented capabilities and the Mac certification steps.

## Install

```bash
bun add @zhivex-ai/sdk @zhivex-ai/apple-local
```

## Usage

Start the experimental helper on a Mac before running this example:

```bash
swift run --package-path examples/apple-local-bridge
```

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createAppleLocal, createAppleLocalStdioTransport } from "@zhivex-ai/apple-local";

const apple = createAppleLocal({
  transport: createAppleLocalStdioTransport({
    command: "apple-local-bridge"
  })
});

const availability = await apple.availability();
console.log(availability.contextSize, availability.supportedLanguages);

const result = await generateText({
  model: apple("apple-on-device"),
  prompt: "Summarize this note in one sentence."
});

console.log(result.text);
```

`apple-on-device` is the general on-device model. `apple-on-device-content-tagging` selects the content-tagging use case. Streaming, callable tools, and native structured output are enabled. Named tool choice, reasoning, embeddings, audio, files, and web search fail with a capability error. Image parts are sent only when `availability().imageInput` is true.
