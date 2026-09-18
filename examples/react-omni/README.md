# React Omni and realtime example

A runnable Bun development example covering Qwen3.8-Omni-Flash media uploads, agent
tool approval, resumable HTTP streaming, and a separate Qwen Realtime voice connection.

From the repository root:

```bash
bun install --frozen-lockfile
bun run build
bun --env-file=.env run examples/react-omni/server.ts
```

Set `QWEN_API_KEY` (or `DASHSCOPE_API_KEY`) in the server environment. Optionally set
`QWEN_REALTIME_MODEL`; the default is `qwen3.5-omni-flash-realtime`. Open
`http://127.0.0.1:4179` and attach image/audio/video files. Ask the assistant to consult
context to exercise the approval tool. Use the separate voice panel to connect, enable
and stop the microphone, interrupt a response and disconnect. Provider calls incur the
account's normal usage; the browser fixture described below never calls the provider.

- [app.tsx](./app.tsx): reusable chat and voice components with custom attachment uploads.
- [routes.ts](./routes.ts): server-owned Runner, approval tool, upload ownership and replay.
- [server.ts](./server.ts): loopback HTTP/WebSocket host with a development session cookie.

HTTP Omni returns text, not generated speech. Voice uses a distinct realtime model.
The example keeps credentials, model selection, tools, budget and session identity on
the server. GET replay never starts another run; POST approval resumes the saved run.

This is a single-process development host, not a production authentication or storage
service. Uploads are capped at 8 MiB each/32 MiB overall, expire after ten minutes and
are authorized by owner. The example resolves its own upload references to data URLs
on the server for Qwen, so session history may contain base64 media. Production apps
should use durable session/run stores and object storage with provider-accessible,
scoped URLs and explicit retention. Replace the local cookie with real user/tenant
authentication, apply rate limits, configure upload MIME/content validation and TLS,
and use the same authorization for replay/cancel and WebSocket upgrades.

The automated browser fixture uses these same routes with a mocked Qwen HTTP endpoint
and a fake realtime session, plus Chromium's simulated microphone. Run:

```bash
bunx playwright install chromium
bun run test:react:browser
```

It verifies image/audio/video request mapping, approved tool execution exactly once,
replay after a truncated response, PCM microphone frames, repeated microphone start,
interruption and disconnect. It verifies software integration; it is not live provider,
physical microphone, spatial-audio, maximum-context or multi-region certification.

## Live certification

The voice panel also accepts typed input, so you can hear a response without granting
microphone permission. Its waveform indicates microphone state, not measured loudness.
Chat and voice adapt to the system color scheme; theme tokens remain customizable.

The opt-in suites make real, billable provider requests with credentials kept on the server:

```bash
QWEN_OMNI_INTEGRATION=1 bun --env-file=.env run test:integration packages/qwen/tests/omni-flash.integration.test.ts
QWEN_REACT_INTEGRATION=1 bun --env-file=.env run test:integration packages/react/tests/qwen-realtime.integration.test.ts
QWEN_REACT_INTEGRATION=1 bunx playwright test --config playwright.react-live.config.ts
```

For speech input certification, also set `QWEN_LIVE_PCM_PATH` to a raw PCM16LE,
16 kHz mono file (at most 30 seconds) saying “Please say exactly: audio input verified.”
The relay suite streams it in 100 ms chunks, waits for server VAD, checks the transcript
and audio response. Without this optional fixture it only verifies silent input acceptance,
text-to-speech, active cancellation and session reuse. Use synthetic or authorized speech.

See [recorded live results](../../docs/REACT_QWEN_LIVE.md). Chromium screenshots are saved
under `.cache/react-live-results`; credentials and full provider payloads are not recorded.
