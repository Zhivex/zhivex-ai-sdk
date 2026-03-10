import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createTextMessage, embed, embedMany, generateObject, generateText, streamText } from "../src/index.js";
import type { EmbeddingModel, LanguageModel, StreamEvent, ToolSet } from "../src/index.js";
import { UnsupportedFeatureError, ValidationError } from "../src/index.js";

const createLanguageModel = (overrides?: Partial<LanguageModel>): LanguageModel => ({
  provider: "test",
  modelId: "model",
  capabilities: {
    streaming: true,
    tools: true,
    structuredOutput: true,
    vision: true,
    files: false,
    embeddings: false
  },
  async generate() {
    return { messages: [createTextMessage("assistant", "hello world")], text: "hello world" };
  },
  async stream() {
    return (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "text-delta", textDelta: "hello" };
      yield { type: "text-delta", textDelta: " world" };
      yield { type: "finish", finishReason: "stop" };
    })();
  },
  ...overrides
});

const createEmbeddingModel = (overrides?: Partial<EmbeddingModel>): EmbeddingModel => ({
  provider: "test",
  modelId: "embed",
  capabilities: {
    streaming: false,
    tools: false,
    structuredOutput: false,
    vision: false,
    files: false,
    embeddings: true
  },
  async embed() {
    return {
      embeddings: [[0.1, 0.2]]
    };
  },
  ...overrides
});

describe("core helpers", () => {
  it("generates text from prompt", async () => {
    const result = await generateText({
      model: createLanguageModel(),
      prompt: "Say hi"
    });

    expect(result.text).toBe("hello world");
    expect(result.messages.at(-1)?.role).toBe("assistant");
  });

  it("executes tools across multiple steps", async () => {
    let call = 0;
    const tools: ToolSet = {
      weather: {
        name: "weather",
        schema: z.object({ city: z.string() }),
        execute: ({ city }) => ({ city, forecast: "sunny" })
      }
    };

    const model = createLanguageModel({
      async generate() {
        call += 1;
        if (call === 1) {
          return {
            messages: [
              {
                role: "assistant",
                parts: [{ type: "tool-call", toolCall: { id: "1", name: "weather", input: { city: "Madrid" } } }]
              }
            ]
          };
        }

        return { messages: [createTextMessage("assistant", "Madrid is sunny.")], text: "Madrid is sunny." };
      }
    });

    const result = await generateText({
      model,
      prompt: "Weather?",
      tools,
      maxSteps: 2
    });

    expect(result.text).toBe("Madrid is sunny.");
    expect(result.toolResults).toHaveLength(1);
    expect(result.messages.at(-3)?.role).toBe("assistant");
    expect(result.messages.at(-2)?.role).toBe("tool");
    expect(result.messages.at(-1)?.role).toBe("assistant");
  });

  it("validates structured output in native mode", async () => {
    const result = await generateObject({
      model: createLanguageModel({
        async generate() {
          return {
            messages: [createTextMessage("assistant", JSON.stringify({ title: "Soup", servings: 2 }))],
            text: JSON.stringify({ title: "Soup", servings: 2 })
          };
        }
      }),
      prompt: "Generate JSON",
      schema: z.object({
        title: z.string(),
        servings: z.number()
      }),
      mode: "native"
    });

    expect(result.object.title).toBe("Soup");
    expect(result.objectMode).toBe("native");
  });

  it("falls back to prompted mode when auto is requested without native structured output", async () => {
    const result = await generateObject({
      model: createLanguageModel({
        capabilities: {
          streaming: true,
          tools: true,
          structuredOutput: false,
          vision: false,
          files: false,
          embeddings: false
        },
        async generate() {
          return {
            messages: [createTextMessage("assistant", JSON.stringify({ title: "Soup" }))],
            text: JSON.stringify({ title: "Soup" })
          };
        }
      }),
      prompt: "Generate JSON",
      schema: z.object({
        title: z.string()
      })
    });

    expect(result.objectMode).toBe("prompted");
  });

  it("rejects invalid structured output", async () => {
    await expect(
      generateObject({
        model: createLanguageModel({
          async generate() {
            return {
              messages: [createTextMessage("assistant", "{\"title\": 1}")],
              text: "{\"title\": 1}"
            };
          }
        }),
        prompt: "Generate JSON",
        schema: z.object({
          title: z.string()
        })
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("streams text deltas", async () => {
    const result = streamText({
      model: createLanguageModel(),
      prompt: "Stream"
    });

    expect(await result.collect()).toMatchObject({ text: "hello world" });
  });

  it("streams tools across multiple steps", async () => {
    let call = 0;
    const result = streamText({
      model: createLanguageModel({
        async stream() {
          call += 1;
          if (call === 1) {
            return (async function* (): AsyncGenerator<StreamEvent> {
              yield { type: "tool-call", toolCall: { id: "1", name: "weather", input: { city: "Madrid" } } };
              yield { type: "finish", finishReason: "tool-calls" };
            })();
          }

          return (async function* (): AsyncGenerator<StreamEvent> {
            yield { type: "text-delta", textDelta: "Madrid is sunny." };
            yield { type: "finish", finishReason: "stop" };
          })();
        }
      }),
      prompt: "Weather?",
      maxSteps: 2,
      tools: {
        weather: {
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, forecast: "sunny" })
        }
      }
    });

    const events: StreamEvent[] = [];
    for await (const event of result.eventStream) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "tool-call")).toBe(true);
    expect(events.some((event) => event.type === "tool-result")).toBe(true);
    expect((await result.collect()).text).toBe("Madrid is sunny.");
  });

  it("embeds values", async () => {
    const result = await embed({
      model: createEmbeddingModel(),
      value: "vectorize"
    });

    expect(result.values).toEqual(["vectorize"]);
    expect(result.embeddings[0]).toHaveLength(2);
  });

  it("embeds many values", async () => {
    const result = await embedMany({
      model: createEmbeddingModel({
        async embed(input) {
          return {
            embeddings: input.values.map((value, index) => [value.length, index])
          };
        }
      }),
      value: ["a", "bb"]
    });

    expect(result.embeddings).toEqual([
      [1, 0],
      [2, 1]
    ]);
  });

  it("propagates unsupported features", async () => {
    await expect(
      embed({
        model: createEmbeddingModel({
          async embed() {
            throw new UnsupportedFeatureError("No embeddings");
          }
        }),
        value: "x"
      })
    ).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });
});
