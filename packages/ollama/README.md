# @zhivex-ai/ollama

Ollama adapter for Zhivex AI SDK.

## Install

```bash
bun add @zhivex-ai/sdk @zhivex-ai/ollama
```

## Usage

Start Ollama and pull the model before running the example:

```bash
ollama pull llama3.2
```

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createOllama } from "@zhivex-ai/ollama";

const ollama = createOllama({
  baseURL: process.env.OLLAMA_HOST ?? "http://localhost:11434"
});

const result = await generateText({
  model: ollama("llama3.2"),
  prompt: "Explain why local inference is useful."
});

console.log(result.text);
```

The adapter supports streaming, callable tools, JSON/structured output, image input for compatible models, and text embeddings through `ollama.embeddingModel(modelId)`. It does not expose provider-hosted tools, remote MCP, audio, files, or shared reasoning controls. Exact capabilities still depend on the locally installed Ollama model.

`createOllama()` reads `OLLAMA_HOST` and otherwise defaults to `http://localhost:11434`. An explicit `baseURL` takes precedence.

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
