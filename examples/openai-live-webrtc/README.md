# Next.js Live WebRTC route and client recipe (experimental)

These typechecked modules fit an existing Next.js App Router project with a Node
backend worker. They are not a standalone service. Use the artifacts from this
branch until the new entrypoints are released; the currently published adapter
does not contain them. Do not upgrade or publish package versions to try this recipe.

Set `OPENAI_API_KEY=<your-existing-server-key>` in the server environment only.
In `app/api/voice/route.ts`, export `runtime = "nodejs"` and the `POST` / `DELETE`
functions from `createVoiceRoutes(yourVoiceApp)`. Implement the `VoiceApp` hooks
using your existing authentication, bounded route middleware, atomic session
store and long-lived worker. Read [server.ts](./server.ts) for the complete hook
contract. A serverless route must dispatch work to that worker; it cannot own an
indefinitely running sideband after returning a response.

The application issues a short-lived, owner-bound, single-use creation lease after
authentication. Its watchdog reconciles canceled requests, closes any known orphan
ID via the sideband, and reports unknown provider outcomes. Origin checks alone do
not authenticate users. Enforce HTTPS, request-byte limits (including DELETE),
per-user/tenant quotas and concurrency before creation. Bind session IDs to the
same user/conversation before allowing DELETE or sideband attachment. Do not accept
session configuration, model IDs, arbitrary URLs or API keys from browser input.

From your Start button, obtain a permissioned stream in your own app and call
`connectVoice(stream, audioElement, leaseId, abortSignal)` from [client.ts](./client.ts).
Render the audio controls to recover from blocked autoplay. Consume
`session.eventStream()` for captions and usage. End with `endVoice()` and record
any close error as unconfirmed final usage. Unmount/abort must also clear playback
and stop the original stream that your app owns; the SDK stops its clones only.

Muted input keeps the paid voice session active. Graceful close waits for
`session.closed`. SDK resource cleanup alone is not proof of provider finalization.
The backend worker owns the existing Luna/tool delegation callback; avoid running
the same delegated action in both browser and backend. Carry permissions, task
revisions and durable external operation IDs across voice reconnections.

Offline validation: `bun run build`, `bun run typecheck:examples`,
`bun run test packages/openai/tests/live-webrtc.test.ts`, and
`bun run test:openai-live:browser`. Those commands make no OpenAI requests and never
capture real devices. Real-provider certification requires a separately approved
paid test with non-sensitive synthetic audio; it has not been performed here.
