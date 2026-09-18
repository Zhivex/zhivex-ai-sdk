# Realtime recipes

Realtime transports and the live agent runtime. See the [OpenAI Live guide](../OPENAI_LIVE.md) for provider-specific certification boundaries.

[Documentation index](../README.md)

## Realtime Sessions

The shared realtime session and live-agent lifecycle contracts are **Stable**.
Individual provider model IDs and upstream preview availability remain
provider-scoped, so keep the provider matrix and
[`STABILITY.md`](../../STABILITY.md) in the release review.

The shared realtime contract lets provider adapters expose low-latency audio/text sessions without changing the rest of your app architecture.

```ts
import { tool } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";
import { z } from "zod";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const session = await openai.realtimeModel!("gpt-realtime").connect({
  instructions: "Keep answers short.",
  tools: {
    weather: tool({
      name: "weather",
      schema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, forecast: "sunny" })
    })
  }
});

await session.sendText("How is Madrid today?");

for await (const event of session.eventStream()) {
  if (event.type === "realtime-text-delta") {
    process.stdout.write(event.textDelta);
  }
}
```

OpenAI's current realtime audio models use the same shared contract:

```ts
const voiceAgent = await openai.realtimeModel!("gpt-realtime-2.1").connect({
  instructions: "Resolve the user's request while keeping latency low.",
  reasoning: { effort: "high" },
  outputAudioMediaType: "audio/pcm",
  voice: "marin",
  providerOptions: {
    safety_identifier: "user_8f2a"
  }
});

const translation = await openai.realtimeModel!("gpt-realtime-translate").connect({
  translation: {
    sourceLanguage: "en",
    targetLanguage: "es"
  },
  outputAudioMediaType: "audio/pcm"
});

const transcription = await openai.realtimeModel!("gpt-realtime-whisper").connect({
  inputTranscription: {
    language: "es",
    includeLogprobs: true,
    delay: "low"
  },
  inputAudioMediaType: "audio/pcm",
  inputSampleRateHz: 24_000,
  noiseReduction: { type: "near_field" }
});
```

Gemini 3.5 Live Translate uses the same shared translation shape for low-latency speech-to-speech translation:

```ts
const liveTranslate = await gemini.realtimeModel!("gemini-3.5-live-translate-preview").connect({
  mode: "translation",
  translation: {
    sourceLanguage: "en",
    targetLanguage: "pl"
  },
  inputAudioTranscription: true,
  outputAudioTranscription: true,
  outputAudioMediaType: "audio/pcm",
  providerOptions: {
    apiVersion: "v1alpha",
    translationConfig: {
      echoTargetLanguage: true
    }
  }
});
```

Gemini 3.5 Transcribe Live is a dedicated speech-to-text session. It accepts audio only and returns transcript events rather than synthesized audio:

```ts
const liveTranscription = await gemini.realtimeModel!("gemini-3.5-transcribe-live").connect({
  mode: "transcription",
  inputAudioTranscription: {
    languageCodes: [],
    customVocabulary: ["Zhivex"]
  }
});
```

Current shared provider coverage for realtime sessions:

OpenAI `gpt-live-1` supports server WebSockets and client delegation through
`realtimeModel().connect()` and `runRealtimeDelegations()`. It uses continuous
audio and an independent backend agent, with timestamped transcript fragments
and acknowledged close. See [GPT-Live support and the agent recipe](../OPENAI_LIVE.md).
Managed Responses delegation, WebRTC and SIP are not implemented by this adapter.

- OpenAI
- Azure OpenAI
- Gemini
- Vertex
- Qwen

Notes:

- Providers that require auth headers during the WebSocket handshake, such as OpenAI, Azure OpenAI, and Vertex server-side sessions, should be given a custom `realtimeConnectionFactory` in Node/Bun. Azure API keys are never placed in realtime URLs.
- Credentialed provider endpoints require HTTPS and realtime endpoints require WSS. Per-session realtime overrides stay on the provider's trusted host. Server-side private gateways can opt out explicitly with `allowUnsafeEndpoints: true`; never derive that option or an endpoint URL from untrusted request input.
- Credentialed provider requests do not follow redirects. Anthropic and Azure OpenAI reject redirected authenticated requests before replaying their non-standard API-key headers or request bodies; their explicit `rawFetch` escape hatches remain uncredentialed. Gemini resumable uploads additionally accept `x-goog-upload-url` only on the configured API host or a public `googleapis.com` host before any file bytes are sent.
- The browser-safe default WebSocket connection bounds each incoming frame to 16 MiB before decoding. Use `maxIncomingFrameBytes` when a provider contract needs a different bound.
- Browser-token helpers are currently exposed for OpenAI, Azure OpenAI, and Gemini.
- Gemini, Vertex, and Azure OpenAI sessions support `sendMedia()` for image inputs such as `image/jpeg`.
- OpenAI supports `sendMedia()` for image inputs on `gpt-realtime`, `gpt-realtime-2`, `gpt-realtime-2.1`, `gpt-realtime-mini`, and `gpt-realtime-2.1-mini`, but not on the older `gpt-4o-*-realtime-preview`, `gpt-realtime-translate`, or `gpt-realtime-whisper` models.
- OpenAI Realtime sends `providerOptions.safety_identifier` as the `OpenAI-Safety-Identifier` header. Provider-executed MCP lifecycle and approval requests are emitted as `realtime-provider-data`; use `openAIRealtimeMcpApprovalResult()` with `session.sendToolResult()` to answer an approval request.
- OpenAI `gpt-realtime-translate` uses realtime translation mode and requires `translation.targetLanguage`; OpenAI `gpt-realtime-whisper` uses realtime transcription mode and emits transcript events without model audio output.
- Gemini and Vertex Live sessions request the audio output modality required by the current Google Live models. Enable `outputAudioTranscription` when application code also needs text output. Sessions can opt into typed `inputAudioTranscription`, `mediaResolution`, `affectiveDialog`, `proactiveAudio`, and `reasoning` setup fields where the selected model supports them. Gemini `gemini-3.1-flash-live-preview` rejects `affectiveDialog` and `proactiveAudio` before opening a WebSocket. For Gemini API preview-only Live features, pass `providerOptions: { apiVersion: "v1alpha" }`.
- Gemini and Vertex `gemini-3.5-live-translate-preview` sessions map `translation.targetLanguage` to Google Live `translationConfig.targetLanguageCode`, emit translated audio plus assistant transcript events, and reject tools, text input, image input, reasoning, and system instructions before the request is sent. Vertex availability still depends on the selected project, region, and model access.
- Qwen Realtime accepts callable tools with automatic selection; `toolChoice: "none"` is enforced locally by omitting tools. It rejects `"required"`, named-tool selection, and `providerOptions.enable_search: true` combined with tools before opening the WebSocket. Output defaults to `modalities: ["text"]`; configure `voice` or `outputAudioMediaType` to request `modalities: ["text", "audio"]`. These validations intentionally fail closed against Qwen's current realtime contract.
- Advanced provider-specific session fields can still be passed through `RealtimeSessionConfig.providerOptions`.

For browser-driven interview-style flows, you can send camera frames through the shared contract on providers that support realtime image input:

```ts
import { createGemini } from "@zhivex-ai/gemini";

const gemini = createGemini({
  apiKey: process.env.GEMINI_API_KEY
});

const session = await gemini.realtimeModel!("gemini-3.1-flash-live-preview").connect({
  instructions: "Observe the camera feed and give concise interview feedback.",
  outputAudioMediaType: "audio/pcm",
  inputAudioTranscription: true,
  outputAudioTranscription: true,
  mediaResolution: "MEDIA_RESOLUTION_LOW",
  providerOptions: {
    apiVersion: "v1alpha"
  }
});

await session.sendMedia({
  data: jpegFrameBase64,
  mediaType: "image/jpeg"
});
```

## Live Agent Runtime

`streamLiveAgent()` sits one level above raw realtime sessions. It wires a realtime-capable model to local tools, tool approval policies, guardrails, telemetry, and optional state persistence.

```ts
import { streamLiveAgent, tool } from "@zhivex-ai/sdk";
import { createGemini } from "@zhivex-ai/gemini";
import { z } from "zod";

const gemini = createGemini({
  apiKey: process.env.GEMINI_API_KEY
});

const live = streamLiveAgent(
  {
    id: "voice-weather",
    model: gemini.realtimeModel!("gemini-live-2.5-flash-native-audio"),
    instructions: "Speak briefly and use tools when needed.",
    tools: {
      weather: tool({
        name: "weather",
        schema: z.object({ city: z.string() }),
        execute: async ({ city }) => ({ city, forecast: "sunny" })
      })
    }
  },
  {
    prompt: "How is Madrid today?",
    realtime: {
      outputAudioMediaType: "audio/pcm",
      outputAudioTranscription: true
    }
  }
);

for await (const chunk of live.textStream) {
  process.stdout.write(chunk);
}

const result = await live.collect();
console.log(result.outputText);
```

Maintainers certify `streamLiveAgent()` separately from ordinary provider smoke.
The opt-in gate uses real Gemini, Qwen, and OpenAI realtime sessions, requires one
local tool execution, a non-empty post-tool response, and a closed session. See
the [realtime/live certification guide](../maintainers/AGENT_REALTIME_CERTIFICATION.md).

The [September provider certification](../maintainers/WEEKLY_PROVIDER_LIVE_2026_09_16.md)
records installed-package evidence for the new DeepSeek, Gemini, Anthropic, and
OpenAI surfaces, with Qwen-hosted DeepSeek tested separately.

