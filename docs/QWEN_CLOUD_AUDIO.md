# Qwen Cloud audio and realtime

The Qwen provider separates three WebSocket protocols instead of sending every audio ID to the chat endpoint. Use the Qwen Cloud compatible base URL (`https://maas.qwencloudapi.com/compatible-mode/v1`); realtime and inference URLs follow the same host.

## Speech synthesis and recognition

```ts
import { createQwen } from "@zhivex-ai/qwen";

const qwen = createQwen({
  baseURL: "https://maas.qwencloudapi.com/compatible-mode/v1",
});
const speech = await qwen.speechModel!("qwen-audio-3.0-tts-flash").generateSpeech({
  input: "Hello.",
  voice: "longanhuan_v3.6",
  providerOptions: { format: "pcm", sample_rate: 16000 },
  timeoutMs: 20_000,
});
const transcript = await qwen.streamingASRModel("qwen-audio-3.0-asr-flash-streaming").transcribe({
  audio: { data: speech.audio, mediaType: "audio/pcm" },
  language: "en",
  timeoutMs: 20_000,
});
```

Audio 3.0 TTS uses `run-task`, waits for `task-started`, then sends text and `finish-task`. `streamSpeech` yields binary audio chunks and `generateSpeech` combines them. The default format is MP3 and default voice is `longanhuan_v3.6`. Provider options include rate, pitch, volume, sample rate, instructions and SSML. A connection closes on completion, failure, cancellation or early stream return. Tasks are not automatically retried, avoiding duplicate synthesis charges.

Streaming ASR accepts an `AsyncIterable<Uint8Array>` with `streamTranscription` for incremental results. Recorded audio can use `transcribe`. The inference transport sends binary audio only after the task acknowledgement. Transcript events preserve partial/final state, timestamps and native metadata. Hotwords, context and language hints are available through typed provider options. Default sample rate is 16 kHz. The adapter bounds a task to 32 MiB input/output and a default 60-second timeout; choose an explicit timeout for longer recordings. ASR filetrans and synchronous HTTP models have different transports.

Custom `realtimeConnectionFactory` implementations for inference audio must implement the optional `recvFrame()` and `sendBinary()` methods. The standard Bun/Node authenticated transport implements both, preserves JSON receive semantics, disables redirects, and bounds frames plus its receive queue. API keys remain server-side; browser bearer-authenticated WebSockets are unsupported.

## Realtime speech and Omni

```ts
const session = await qwen.realtimeModel("qwen3.8-omni-flash-realtime").connect({
  voice: "Tina",
  outputAudioMediaType: "audio/pcm",
  turnDetection: null,
  providerOptions: { video: { input: { representation_compact: "normal" } } },
});
await session.sendText("Say hello.");
// Consume session.eventStream(), then close when the conversation ends.
```

Audio 3.0 Flash/Plus and 3.1 Plus use the speech conversation protocol. Inputs are mono PCM16 at 16 kHz; outputs are PCM16 at 24 kHz. Image frames are rejected. Manual mode (`turnDetection: null`) commits final audio and optionally requests a response. VAD mode lets the server decide when to respond. Audio 3.1 additionally accepts language controls. Voice is fixed by the first session update; format and turn-detection updates are rejected after audio starts.

Omni 3.8 accepts PCM16 input with 1, 2 or 4 interleaved channels. Layout must match (`mono`, `raw_mic_array`, `foa_ambix`). Output can be PCM or WAV at 8/16/24/48 kHz and event metadata reports the configured format. The default voice is Tina. Compact video (`normal`) reduces video tokens when fine detail is unnecessary; multichannel audio increases audio token cost. Set audio/video configuration before sending audio.

MCP servers use `providerOptions.mcpServers`, with HTTPS endpoints, unique labels, optional allowed tools and credentials. Approval defaults to `always`. Function and MCP tools can coexist; tools cannot coexist with web search. MCP discovery, approval and result events remain available as `realtime-provider-data`. Wait for tool discovery before requesting a response that needs those tools. On a pending `mcp_approval_request`, call `session.respondToMcpApproval(item.id, boolean)`. Unknown/duplicate approvals are rejected. After the parent `response.done`, call `session.createResponse()` once to continue from server-executed MCP results. MCP configuration cannot change during an active response.

## Validation evidence (2026-09-26)

Authenticated, bounded smoke tests used the existing key and short generated content:

| Route | Result |
| --- | --- |
| Audio 3.0 TTS Flash | `Hi.` produced 18,811 MP3 bytes |
| Audio 3.0 ASR Flash Streaming | Generated `Hello.` (28,160 PCM bytes) produced 7 transcript characters |
| Audio 3.0 Realtime Flash | Text request produced 38,400 PCM bytes, transcript and completed response |
| Omni 3.8 Realtime | Text request produced 46,080 PCM bytes, transcript and completed response |

An initial Omni request using legacy `Cherry` was rejected; the documented `Tina` voice succeeded. These tests validate the listed routes, not every language, premium model, multichannel device, MCP service, or transport. MCP, format validation, cancellation, binary framing and task failure handling are covered by deterministic tests. Browser WebRTC and an optional official-native AOQ bridge are described in [realtime transports](QWEN_REALTIME_TRANSPORTS.md); their live certification is separate.

The reusable smoke suite is opt-in (three tests exercising all four routes). It generates `Hello.` once as PCM and reuses those bytes for ASR; each test has a 30-second abort deadline and no paid retries:

```bash
QWEN_CLOUD_AUDIO_INTEGRATION=1 bunx vitest run --config vitest.integration.config.ts packages/qwen/tests/cloud-audio.integration.test.ts
```

The integration configuration reads `.env`; keep credentials there or in environment variables. The suite asserts results without logging audio, transcripts or secrets.

References: [TTS](https://docs.qwencloud.com/developer-guides/speech/realtime-streaming), [ASR client events](https://docs.qwencloud.com/api-reference/speech-recognition/fun-asr-realtime/client-events), [Audio realtime](https://docs.qwencloud.com/api-reference/qwen-audio-realtime/client-events), [Omni client events](https://docs.qwencloud.com/api-reference/real-time-multimodal/client-events), [MCP lifecycle](https://docs.qwencloud.com/api-reference/real-time-multimodal/interaction-process).
