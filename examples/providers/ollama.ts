import { generateText } from "@zhivex-ai/sdk";
import { createOllama } from "@zhivex-ai/ollama";

const ollama = createOllama({
  baseURL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434"
});

const result = await generateText({
  model: ollama("llama3.2"),
  prompt: "Say hello from the Ollama adapter."
});

console.log(result.text);
