import { generateImage, generateSpeech, generateVideo, transcribeAudio } from "@zhivex-ai/sdk";
import { createXAI } from "@zhivex-ai/xai";

import { requiredEnv, section } from "../_shared";

const xai = createXAI({
  apiKey: requiredEnv("XAI_API_KEY")
});

section("Image");
const image = await generateImage({
  model: xai.imageGenerationModel("grok-imagine-image-2.0"),
  prompt: "A small paper boat on a quiet pond",
  aspectRatio: "1:1",
  providerOptions: { resolution: "1k", response_format: "url" }
});
console.log(image.images[0]?.uri ?? image.images[0]?.mediaType);

section("Video");
const video = await generateVideo({
  model: xai.videoGenerationModel("grok-imagine-video-1.5"),
  prompt: "A paper boat drifts across a quiet pond",
  durationSeconds: 4,
  aspectRatio: "16:9",
  pollIntervalMs: 5_000,
  providerOptions: { resolution: "480p" }
});
console.log(video.videos[0]?.uri);

section("Speech");
const speech = await generateSpeech({
  model: xai.speechModel("grok-tts"),
  input: "Hello from the xAI voice example.",
  voice: "eve",
  providerOptions: { language: "en" }
});
console.log(speech.mediaType, speech.audio.byteLength);

section("Transcription");
const transcript = await transcribeAudio({
  model: xai.transcriptionModel("grok-voice-transcribe-2.0"),
  audio: { data: speech.audio, mediaType: speech.mediaType, filename: "hello.mp3" },
  language: "en"
});
console.log(transcript.text);
