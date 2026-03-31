import { readFile } from "node:fs/promises";

import { transcribeAudio } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

import { requiredEnv, section } from "../_shared";

const openai = createOpenAI({
  apiKey: requiredEnv("OPENAI_API_KEY")
});

const audioPath = requiredEnv("AUDIO_FILE_PATH");
const audio = await readFile(audioPath);

section("Transcription");

const result = await transcribeAudio({
  model: openai.transcriptionModel!("gpt-4o-mini-transcribe"),
  audio: {
    data: new Uint8Array(audio),
    mediaType: "audio/wav",
    filename: "sample.wav"
  }
});

console.log(result.text);
