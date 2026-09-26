# Qwen Cloud native ASR

The synchronous `qwen-audio-3.0-asr-flash` uses the native multimodal generation endpoint through `transcriptionModel`. The filetrans models use asynchronous native jobs through `fileTranscriptionModel`.

```ts
import { createQwen, QWEN_CLOUD_BASE_URL } from "@zhivex-ai/qwen";
const qwen = createQwen({ apiKey: process.env.QWEN_API_KEY, baseURL: QWEN_CLOUD_BASE_URL });

const transcript = await qwen.transcriptionModel("qwen-audio-3.0-asr-flash").transcribe({
  audio: { data: "https://example.com/audio.wav", mediaType: "audio/wav" },
  providerOptions: { sample_rate: "16000" }
});

const filetrans = qwen.fileTranscriptionModel("qwen-audio-3.1-asr-flash-filetrans");
const pending = await filetrans.submit({
  fileURL: "https://example.com/audio.wav",
  keepDialect: true,
  languageHints: ["zh"]
});
const task = await filetrans.get({ taskId: pending.taskId });
// Poll with your application's deadline/backoff while PENDING or RUNNING.
// Check every result.status, even if task.status === "SUCCEEDED".
// Successful results expose transcriptionURL for caller-controlled retrieval.
```

The filetrans extension supports language hints, channel IDs, speaker diarization/count, vocabulary IDs, inline weighted vocabulary, and conversation context. `keepDialect` is restricted to the 3.1 model. A request submits exactly one file URL. HTTP/HTTPS public file URLs are forwarded to Qwen for processing; they are not fetched locally. Returned transcript URLs are validated and exposed without automatic downloads or credential forwarding.

Input validation rejects private endpoints, malformed IDs, inconsistent diarization, invalid vocabulary weights and wrong model routes. Provider error messages are not retained because they may echo private audio URLs. API responses are bounded to 2 MiB and requests use abortable 30-second timeouts by default. Submission is never automatically retried, avoiding duplicate jobs and charges. Failed jobs preserve their status and code. Overall success does not hide failed subtasks.

Synchronous ASR accepts URL, base64/data URI and byte audio. Options include native `format`, `sample_rate`, `language`, `vocabulary` and `context`; unknown options are rejected. `prompt` becomes a preceding input-text message. Byte input is limited to 20 MiB; encoded input has a 28 MiB request guard. The service still determines accepted formats, model limits and account availability.

## Evidence

September 26, 2026:

- 14 contract tests passed for native request mapping, async headers, partial failures, task identity, endpoint safety and validation.
- A short official hello-world WAV (approximately 3.8 seconds) passed live synchronous transcription with `qwen-audio-3.0-asr-flash`.
- The same sample passed a live `qwen-audio-3.0-asr-flash-filetrans` job from submission through successful polling.
- The 3.1 filetrans mapping is contract-tested; it was not separately billed for live certification.

Run explicitly with:

```bash
QWEN_NATIVE_ASR_LIVE=1 QWEN_FILETRANS_LIVE=1 \
bun --env-file=.env run node_modules/vitest/vitest.mjs run packages/qwen/tests/native-asr.live.test.ts
```

Sources: [synchronous ASR model API example](https://www.qwencloud.com/models/qwen-audio-3.0-asr-flash) and [filetrans API](https://docs.qwencloud.com/api-reference/speech-recognition/fun-asr-recording/restful-api).
