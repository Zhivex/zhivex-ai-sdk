import { writeFile } from "node:fs/promises";

import { generateSpeech } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

import { requiredEnv, section } from "../_shared";

const openai = createOpenAI({
  apiKey: requiredEnv("OPENAI_API_KEY")
});

section("Speech");

const result = await generateSpeech({
  model: openai.speechModel!("gpt-4o-mini-tts"),
  input: "Zhivex AI SDK now exposes a shared text to speech contract."
});

await writeFile("speech-output.mp3", result.audio);
console.log(result.mediaType);
console.log("wrote speech-output.mp3");
