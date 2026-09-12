# GPT-Live-1: server voice with a Zhivex backend

`createOpenAI().realtimeModel!("gpt-live-1")` selects the Live protocol at
`wss://api.openai.com/v1/live/sessions`. It does not send the model to the Realtime
endpoint. This implementation supports **server WebSockets and client delegation**.
Use `model.connect()` with `runRealtimeDelegations()`; `streamLiveAgent()` rejects
full-duplex models because its lifecycle requires response-completion events.

## Connect and run a backend

See the [application recipe](../examples/openai-live-agent.ts) for a bridge to
`runAgent()` with an explicit result-review callback. The backend can use any
Zhivex language model and retains its own tools, permissions, guardrails, memory,
and durable task state. `runRealtimeDelegations` is exported by core, SDK, and
`@zhivex-ai/agents/realtime`.

```ts
import { createOpenAI } from "@zhivex-ai/openai";
import { runRealtimeDelegations } from "@zhivex-ai/core";

// Supply your Node/Bun RealtimeConnectionFactory, with authenticated WebSocket
// headers, bounded frames/queues, AbortSignal handling and transport cleanup.
const openai = createOpenAI({ realtimeConnectionFactory });
const session = await openai.realtimeModel!("gpt-live-1").connect({
  delegation: { type: "client" },
  instructions: "Speak Spanish. Delegate account questions to the backend.",
  voice: "marin",
  inputAudioMediaType: "audio/pcm",
  inputSampleRateHz: 24000,
  providerOptions: { safety_identifier: "hashed-user-id" }
}, { timeoutMs: 15000, signal });

// connect() waits for session.started. Start event consumers before supplying audio.
const backend = runRealtimeDelegations(session, {
  signal,
  onDelegation: async ({ delegation, transcripts, signal, sendUpdate }) => {
    // Application function: run the agent, check current task revision, enforce
    // permissions/confirmations and return a concise, verified, disclosure-safe result.
    const result = await runMyBackend({ delegation, transcripts, signal });
    if (result) await sendUpdate({ kind: "commentary", content: result });
  }
});

try {
  await Promise.all([
    backend,
    (async () => {
      for await (const event of session.eventStream()) {
        if (event.type === "realtime-audio-output") queueForPlayback(event.audio);
        if (event.type === "realtime-transcript") displayFragment(event);
        if (event.type === "realtime-error") throw event.error ?? new Error(event.message);
        if (event.type === "realtime-end") saveFinalUsage(event.providerMetadata);
      }
    })()
  ]);
} finally {
  await session.close();
}
```

`realtimeConnectionFactory`, `signal`, media capture/playback, and the application
functions above are supplied by your application. The browser-safe default socket
cannot attach authorization headers. Keep the API key on the trusted server.
The existing Realtime transport extension point is reused; this change adds no
WebSocket dependency.

Send raw mono audio through `session.sendAudio()`, paced at the actual capture
rate. PCM16 supports 16/24 kHz; G.711 `audio/pcmu` and `audio/pcma` support 8 kHz.
Input and output share one format. PCM chunks must have even byte lengths.
No WAV headers, automatic resampling, audio commits or voice response triggers
are performed. `isFinal` does not end a turn or close the session.

Call `session.close()` from the application's end-conversation control. It sends
`session.close`, waits for `session.closed`, and then releases the transport.
The deadline defaults to 15 seconds (`providerOptions.closeTimeoutMs` can override
it). A timeout or disconnected transport reports unconfirmed final usage.

## Context, delegation and cancellation

- `realtime-delegation` preserves the opaque `delegationId` and `offsetMs`. It is
  not a tool call and contains no task text. The helper supplies an exact snapshot
  of previously received transcript fragments; include startup history and
  authoritative business state separately in your backend.
- Transcripts retain `startMs`, `endMs`, speaker and exact text with `isFinal: false`.
  Overlapping fragments and silence do not establish completed user turns.
- Backend work runs serially while events continue arriving. Exact duplicate
  delegations are ignored. Defaults bound retained text to 65,536 characters,
  accepted delegations to 1,024 and pending tasks to 8; exceeding a bound fails
  explicitly. Persist context and start a new session for longer conversations.
- Speech interruptions do not automatically cancel tools or queued backend work.
  Your backend must reconcile task revisions, corrections, confirmations and
  external operation IDs. A delegation ID is not a durable idempotency key.
- A session end or abort signals active backend work, prevents queued work from
  starting, and rejects late result appends. Cancellation is cooperative and does
  not undo external effects. The helper can finish even if a backend ignores abort.
- `appendContext({ kind: "context" | "commentary" | "instructions", content,
  delegationId?, eventId? })` maps to thinking, commentary or instructions appends.
  Omit the delegation ID for general session context. Non-null IDs must be known
  client delegations. Each append is limited by OpenAI to 500 tokens; the adapter
  does not tokenize or silently truncate results. Use small verified chunks.
- `setInputMuted(true/false)` controls input only. Context/mute acknowledgements,
  usage snapshots and other control events remain `realtime-provider-data`.
  A fulfilled send means transmission, not provider acceptance or playback.
  Match a context acknowledgement's `client_event_id` to your `eventId` when needed.
- Audio is transient and is not replayed to late subscribers. Attach playback
  consumers before capture starts. Track actual playback in the application;
  neither backend completion nor transcripts prove what the user heard.

Initial text history can be supplied through `providerOptions.input` (up to 128
developer/user/assistant text messages). `providerOptions.store` defaults to false.
Startup fields are immutable; `update()` rejects changes in client mode. Use
`appendContext()` for later instructions/context. Typed user input and images go
directly to your backend, not `sendText()` or `sendMedia()` on the voice frontend.

## Scope and validation

The Live voice frontend advertises audio and client delegation, not direct tools,
reasoning, structured output, image input or browser tokens. Backend capabilities
remain those of its chosen model. Managed Responses delegation, WebRTC session
creation, SIP, sideband attachment, recording downloads and forks are not exposed
by this adapter. Unsupported options fail explicitly.

The SDK catalog lists `gpt-live-1` without token prices: voice is duration-billed,
and backend usage is separate. Preserve cumulative usage snapshots and the final
`session.closed` payload rather than adding snapshots together.

Offline tests cover protocol mapping, startup/close acknowledgements, audio
formats, transcript timing, original delegation IDs, queue limits, cancellation,
late results, error propagation and the public SDK bridge. This is not an
authenticated provider certification or a guarantee of microphone/playback quality.

### Authenticated smoke: September 12, 2026

The [recorded real API smoke](openai-live-smoke-2026-09-12.json) passed on the
uncommitted implementation, with source hashes recorded in the report. A locally
synthesized English question was streamed as PCM16/24kHz. GPT-Live transcribed it,
issued one client delegation, returned audio and the transcript “Sure, checking
now. The code is violet seven.”, and acknowledged close with 21 seconds of usage.
The backend was a deterministic callback returning a fixed verification code;
this run did not certify a backend LLM, real microphone/playback quality,
interruptions under load, WebRTC, SIP or a published npm artifact.

Repeat with a non-empty synthetic mono PCM16/24kHz file of at most 15 seconds:

```bash
ZHIVEX_OPENAI_LIVE_SMOKE=1 ZHIVEX_LIVE_PCM_PATH=/absolute/path/input.pcm bun run scripts/openai-live-smoke.ts
```

The script uses `OPENAI_API_KEY`, runs a paid session of approximately 22 seconds,
enforces a 60-second transport deadline, and writes the latest result to
`/tmp/zhivex-openai-live-smoke.json`. Use only non-sensitive test audio.

### Authenticated Qwen agent smoke: September 12, 2026

The [real Qwen agent smoke](openai-live-qwen-smoke-2026-09-12.json) also passed.
GPT-Live delegated the spoken request to `runAgent` using `qwen3.8-flash` with
thinking disabled and automatic tool selection. Qwen called the local read-only
`get_verification_code` tool once, then returned its randomly selected code in a
second model step. The code was available only through the tool result.
GPT-Live produced audio and the matching transcript “The verification code is
violet nine.” Backend execution took 3,934 ms; Qwen reported 2,969 input tokens
(including 1,024 cached) and 21 output tokens. Live acknowledged 35 seconds of usage.

```bash
ZHIVEX_OPENAI_LIVE_SMOKE=1 ZHIVEX_LIVE_BACKEND=qwen ZHIVEX_LIVE_PCM_PATH=/absolute/path/input.pcm bun run scripts/openai-live-smoke.ts
```

This mode additionally requires `QWEN_API_KEY` or `DASHSCOPE_API_KEY`, honors
`QWEN_BASE_URL`, `QWEN_WORKSPACE_ID` and `QWEN_REGION`, limits the agent to three
steps and 20 seconds, and writes `/tmp/zhivex-openai-live-qwen-smoke.json`.
It runs approximately 35 seconds of paid voice traffic, plus Qwen usage.
This single successful session does not validate physical microphone/playback,
real interruption/disconnect recovery, load, or a published npm artifact.

### Real cancellation and transport failure smoke

The [fault-injection record](openai-live-fault-smoke-2026-09-12.json) includes the
initial incomplete attempt and successful interruption/disconnect runs.
A spoken cancellation arrived while a real Qwen tool was deliberately delayed.
An explicit application task revision suppressed the obsolete result; GPT-Live
acknowledged cancellation without disclosing the code. Speech itself did not abort
the bridge. The successful run acknowledged 32 seconds of Live usage.

Abruptly terminating the real WebSocket during a Qwen tool produced a transport
error, aborted the bridge, and rejected a late context update. No final usage was
claimed for that broken connection. This does not undo an already executed tool;
applications must own operation permissions, idempotency and compensation.
Reconnection remains an application responsibility and was not certified here.

```bash
ZHIVEX_OPENAI_LIVE_SMOKE=1 ZHIVEX_LIVE_PCM_PATH=/absolute/path/request.pcm ZHIVEX_LIVE_CANCEL_PCM_PATH=/absolute/path/cancel.pcm bun run scripts/openai-live-fault-smoke.ts interruption
ZHIVEX_OPENAI_LIVE_SMOKE=1 ZHIVEX_LIVE_PCM_PATH=/absolute/path/request.pcm bun run scripts/openai-live-fault-smoke.ts disconnect
```

Use the request “Please ask the backend for the verification code and tell me its
answer” and cancellation “Actually, cancel that request. Do not tell me the code.
Just say cancelled.” Both files must be synthetic mono PCM16/24kHz.
The script uses a 60-second transport deadline, a 20-second agent deadline and
writes results under `/tmp/zhivex-openai-live-<scenario>-smoke.json`.
The cancellation phrase matcher is a synthetic test policy, not a general-purpose
production intent classifier.

Official references, checked September 12, 2026:

- [Getting started](https://developers.openai.com/api/docs/guides/live)
- [WebSocket transport](https://developers.openai.com/api/docs/guides/voice-websockets?api=live)
- [Client delegation](https://developers.openai.com/api/docs/guides/live-delegation?delegation-mode=client)
- [Session lifecycle](https://developers.openai.com/api/docs/guides/live-conversations)
