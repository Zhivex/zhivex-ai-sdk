# Qwen Cloud image, video and world APIs

Reviewed against the official Qwen Cloud and Alibaba Model Studio references on 2026-09-26.
Use the API host assigned to the key. A model published in another region or a Vidu model that has not been activated can still reject a correctly formed request.

## Images

`qwen.imageGenerationModel("qwen-image-3.0")` and `qwen-image-3.0-pro` use the synchronous multimodal generation endpoint. Generation and editing share the same interface. Pass up to three reference images, `count` from 1 to 6, and `size` as `width*height` (512²–2048² total pixels, ratio 1:8–8:1). Omit size to allow the service to choose it. `providerOptions.parameters` carries `prompt_extend`, `prompt_extend_mode`, `enable_thinking`, `watermark` and `seed`. Agent prompt enhancement is text-to-image only.

```ts
const result = await qwen.imageGenerationModel("qwen-image-3.0").generateImage({
  prompt: "A blue circle on a white background.",
  count: 1,
  size: "512*512",
  maxRetries: 0,
  providerOptions: { prompt_extend: false, enable_thinking: false }
});
```

Vidu `vidu/vidu-image_reference2image` uses the asynchronous image-generation endpoint, returns an operation name, and accepts up to fourteen reference images. It produces exactly one PNG, with an explicit set of 1K/2K/4K sizes. Poll the returned operation with `qwen.tasks`; task completion exposes the image in `output.choices[].message.content[].image`.

## Image translation

```ts
const result = await qwen.imageTranslationModel("qwen-mt-image-2.0").translate({
  imageUrl: "https://example.com/product-label.png",
  sourceLanguage: "auto",
  targetLanguage: "es",
  imageSegment: true,
  terminologies: [{ src: "AI", tgt: "IA" }]
});
```

Version 2.0 defaults to synchronous output (`imageUrl`). Set `async: true` to receive `operationName` for task polling. The legacy `qwen-mt-image` model only supports asynchronous calls and has narrower language coverage. Translation accepts a public image URL; the client does not download it. Terminology, sensitive words and domain hints are sent as native `input.ext` fields. Translation and world mutations are never automatically retried.

## Video dialects

| Family | Image input | Controls |
| --- | --- | --- |
| Wan 3.0 / Prime | `input.media`: `first_frame`, `last_frame`, `reference_image`, `reference_video`, `reference_audio`, `file`, `link` | 2–30 seconds or `-1`, 480P/720P/1080P, adaptive ratio, audio toggle |
| HappyHorse 1.x I2V | Exactly one `first_frame` | 3–15 seconds, 480P/720P/1080P |
| HappyHorse 1.x R2V | 1–9 `reference_image` | Same duration/resolution, reference ordering preserved |
| HappyHorse video-edit | One `video` and up to five `reference_image` assets | Source duration/ratio retained, 720P/1080P, `audio_setting`: `auto` or `origin` |
| Vidu Q3 mix/ad/drama | 1–7 `image` | Model-specific duration and ratio converted to `size` |
| Vidu Q2 pro fast I2V | Exactly one `image` | 1–10 seconds, 720P/1080P; output follows source image ratio |

Use `providerOptions.input.media` for multiple media assets and `providerOptions.parameters` for native parameters. The ordinary `image` argument maps to the correct first-image dialect. Wan first/last frames cannot be combined with reference assets; file and link are mutually exclusive and require prompt enhancement. Vidu drama supports 16:9/9:16 and may adjust duration to fit its story; billing follows actual duration.

```ts
const operation = await qwen.videoGenerationModel("wan3.0-video").generateVideo({
  prompt: "A blue circle gently moving on white.",
  durationSeconds: 2,
  aspectRatio: "1:1",
  maxRetries: 0,
  providerOptions: { resolution: "480P", audio: false, prompt_extend: false }
});
```

## HappyOyster REST lifecycle

`qwen.worlds(modelId)` supports `happyoyster-1.0-adventure`, `happyoyster-1.0-directing` and the invitation-only `happyoyster-1.0-acting`.

The client exposes create/buildStatus/get/list/delete, getTravelCredential, enterTravel/endTravel, travelStatus/listTravels/travelArtifacts, pauseTravel/resumeTravel, instructTravel, rewindTravel and updateScript. Adventure requires a first-frame image and perspective. Acting requires a first-frame image; portrait is the service default. Directing requires resolution and supports prompt-driven or structured ScriptList creation. Full script updates require exactly 45 uniquely numbered acts. Model-inapplicable control operations fail before sending a request. Server lifecycle/status remains authoritative: wait for the paused state before resume or rewind.

The endpoint uses `/api/v2/apps/{model}/openapi/v1`, derived from `taskBaseURL` ending in `/api/v1`. Both bare Open API response envelopes and public-gateway `output` envelopes are supported. Nonzero business codes are errors even with HTTP 200.

```ts
const worlds = qwen.worlds("happyoyster-1.0-directing");
const world = await worlds.create({
  resolution: "480p",
  creationModel: "scriptlist",
  scriptList: {
    synopsis: "A friendly robot waves.",
    acts: [{ turn: 1, content: "The robot waves at the viewer." }]
  }
});
// Poll worlds.buildStatus(world.encryptedWorldId) until ready before credential exchange.
```

## Browser RTC bridge

The optional `createQwenWorldRTC` bridge accepts a factory for the official `@happy-oyster/js-sdk` engine. The application installs that browser dependency separately; it is not bundled into the provider. Native Travel methods and events retain their original types, including `sendCommand`, `sendInstruct`, `can`, `on`, `onError`, pause/resume/rewind and end. The official SDK implements RTC playback and Adventure command transport. Our bridge configures the host/model/token, starts the session, and attempts cleanup if startup fails.

```ts
import { createQwenWorldRTC } from "@zhivex-ai/qwen";
import { HappyOysterEngine } from "@happy-oyster/js-sdk";

const rtc = createQwenWorldRTC(config => new HappyOysterEngine(config), {
  APIHost: "maas.qwencloudapi.com",
  model: "happyoyster-1.0-adventure",
  token: temporaryApiKey // st-..., issued by your authenticated backend
});
const travel = await rtc.startTravel({ ticket, videoElement, maxExperienceTimeSec: 60 });
try {
  // Subscribe to official SDK events and use travel.can(action) before controls.
} finally {
  await travel.end();
}
```

Never send the primary API key to the browser. A travel ticket is single-use; do not call REST `enterTravel` before `startTravel`, because the official SDK consumes the ticket itself. Creating a world does not start billable RTC playback. REST and mock bridge tests do not certify browser RTC playback.

## References

- [Qwen image generation](https://docs.qwencloud.com/api-reference/image-generation/qwen-text-to-image)
- [Qwen image editing](https://docs.qwencloud.com/api-reference/image-generation/qwen-image-editing)
- [Image translation](https://docs.qwencloud.com/api-reference/image-translation/qwen-mt-image/synchronous)
- [Wan 3.0](https://docs.qwencloud.com/api-reference/video-generation/wan30-video/create-task)
- [HappyHorse image-to-video](https://docs.qwencloud.com/api-reference/video-generation/happyhorse-image-to-video/create-task)
- [HappyHorse video editing](https://docs.qwencloud.com/api-reference/video-generation/happyhorse-video-editing/create-task)
- [HappyHorse reference-to-video](https://docs.qwencloud.com/api-reference/video-generation/happyhorse-reference-to-video/create-task)
- [Vidu image API](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/vidu-image-generation-api-reference)
- [Vidu reference video API](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/vidu-reference-to-video-api-reference)
- [Vidu first-frame API](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/vidu-image-to-video-api-reference)
- [HappyOyster integration](https://docs.qwencloud.com/api-reference/world-model/happyoyster-integration-flow)
- [HappyOyster Web SDK](https://docs.qwencloud.com/api-reference/world-model/happyoyster-web-sdk-api-reference)

## Live evidence and reproducible checks

On 2026-09-26, using the available key on `maas.qwencloudapi.com`:

| Check | Result | Billable dimensions requested / returned |
| --- | --- | --- |
| Image3 generation | One image returned | One 512×512 image; prompt enhancement and thinking disabled |
| Image3 editing | One image returned using the previous result as reference | One 512×512 output, one input image |
| Wan3 generation | Task SUCCEEDED, video URL returned | Requested 2 seconds, 480P, silent; usage returned duration=2, output_video_duration=2, video_count=1, fps=30, SR=480 |
| MT image 2.0 | Synchronous image URL returned | One official Chinese-text sample translated to English; semantic quality not evaluated |
| HappyHorse 1.1 I2V | Task SUCCEEDED, video URL returned | One 3-second 480P output; usage duration=3, output_video_duration=3, video_count=1, SR=480 |
| Vidu image | Task FAILED: InvalidParameter | Product not activated for this account; no output returned |
| HappyOyster Directing | List, create, build-status, delete succeeded | Resolution 480p; status generating; deletion confirmed; no Travel started |

Full HappyOyster world build, script execution and actual browser RTC playback have contract tests and documentary evidence, not successful authenticated generation evidence in this run. Image translation completed on the official Chinese-text sample with English as target; the returned image was not inspected for semantic quality. No monetary total is inferred from dimensions or account promotions.

Reproduction is opt-in and incurs service usage. Normal `bun run test` skips these tests:

```bash
QWEN_CLOUD_MEDIA_INTEGRATION=1 bun --env-file=.env x vitest run --config vitest.integration.config.ts packages/qwen/tests/cloud-media.integration.test.ts
QWEN_CLOUD_WORLDS_INTEGRATION=1 bun --env-file=.env x vitest run --config vitest.integration.config.ts packages/qwen/tests/cloud-media.integration.test.ts
```

Media opt-in creates exactly one Image3 generation, one edit, and one Wan3 task. World opt-in creates and deletes one Directing world without entering an RTC travel. Neither path automatically retries a creation request. Video polling has a fixed deadline and never resubmits the task.

To reproduce the distinct MT-image, Vidu-image and HappyHorse first-frame routes, a third independent opt-in runs one of each (one image translation, one 1K image and one 3-second 480P video):

```bash
QWEN_CLOUD_EXTENDED_MEDIA_INTEGRATION=1 bun --env-file=.env x vitest run --config vitest.integration.config.ts packages/qwen/tests/cloud-media.integration.test.ts
```

An unavailable/unauthorized model fails an opted-in test; it is never counted as successful certification. The source dimensions, file size and media duration behind public URLs are verified by the service, since the SDK does not fetch reference URLs locally.
