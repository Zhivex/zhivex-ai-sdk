import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  assistant,
  createTextMessage,
  embed,
  embedMany,
  generateObject,
  generateText,
  streamObject,
  streamText,
  system,
  tool,
  user
} from "../src/index.js";
import type { EmbeddingModel, LanguageModel, StreamEvent, ToolSet } from "../src/index.js";
import { UnsupportedFeatureError, ValidationError } from "../src/index.js";

const createLanguageModel = (overrides?: Partial<LanguageModel>): LanguageModel => ({
  provider: "test",
  modelId: "model",
  capabilities: {
    streaming: true,
    tools: true,
    structuredOutput: true,
    jsonMode: true,
    toolChoice: true,
    parallelToolCalls: false,
    vision: true,
    files: false,
    audioInput: false,
    audioOutput: false,
    embeddings: false,
    reasoning: false,
    webSearch: false
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
    jsonMode: false,
    toolChoice: false,
    parallelToolCalls: false,
    vision: false,
    files: false,
    audioInput: false,
    audioOutput: false,
    embeddings: true,
    reasoning: false,
    webSearch: false
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

  it("rejects prompt and messages used together", async () => {
    await expect(
      generateText({
        model: createLanguageModel(),
        prompt: "Say hi",
        messages: [user("Hello")]
      })
    ).rejects.toThrow('Pass either "prompt" or "messages", but not both.');
  });

  it("executes tools across multiple steps", async () => {
    let call = 0;
    const tools: ToolSet = {
      weather: tool({
        name: "weather",
        schema: z.object({ city: z.string() }),
        execute: ({ city }) => ({ city, forecast: "sunny" })
      })
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

  it("builds ergonomic messages", () => {
    expect(system("You are helpful")).toEqual({
      role: "system",
      parts: [{ type: "text", text: "You are helpful" }]
    });
    expect(user("Hello")).toEqual(createTextMessage("user", "Hello"));
    expect(assistant([{ type: "text", text: "Hi" }])).toEqual({
      role: "assistant",
      parts: [{ type: "text", text: "Hi" }]
    });
  });

  it("validates structured output in native mode", async () => {
    const result = await generateObject({
      model: createLanguageModel({
        async generate(input) {
          expect(input.structuredOutput).toMatchObject({ mode: "native", name: "recipe" });
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
      schemaName: "recipe",
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
          jsonMode: false,
          toolChoice: true,
          parallelToolCalls: false,
          vision: false,
          files: false,
          audioInput: false,
          audioOutput: false,
          embeddings: false,
          reasoning: false,
          webSearch: false
        },
        async generate(input) {
          expect(input.structuredOutput).toBeUndefined();
          expect(input.messages.at(-1)).toMatchObject({
            role: "user",
            parts: [{ type: "text", text: "Generate JSON\n\nReturn only valid JSON matching the requested schema." }]
          });
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

  it("streams structured output with partial object events", async () => {
    let requestMode: string | undefined;
    const result = streamObject({
      model: createLanguageModel({
        async stream(input) {
          requestMode = input.structuredOutput?.mode;
          return (async function* (): AsyncGenerator<StreamEvent> {
            yield { type: "text-delta", textDelta: "{\"title\":\"Soup\"" };
            yield { type: "text-delta", textDelta: ",\"servings\":2}" };
            yield { type: "finish", finishReason: "stop" };
          })();
        }
      }),
      prompt: "Generate recipe JSON",
      schema: z.object({
        title: z.string(),
        servings: z.number()
      }),
      mode: "native"
    });

    const partials: Array<Partial<{ title: string; servings: number }>> = [];
    let completedObject: { title: string; servings: number } | undefined;

    for await (const event of result.eventStream) {
      if (event.type === "object-partial") {
        partials.push(event.partialObject);
      }

      if (event.type === "object-complete") {
        completedObject = event.object;
      }
    }

    const final = await result.collect();

    expect(requestMode).toBe("native");
    expect(partials).toContainEqual({ title: "Soup" });
    expect(completedObject).toEqual({ title: "Soup", servings: 2 });
    expect(final.object).toEqual({ title: "Soup", servings: 2 });
  });

  it("streams structured output in prompted mode when native is unavailable", async () => {
    let firstMessageText = "";
    const result = streamObject({
      model: createLanguageModel({
        capabilities: {
          streaming: true,
          tools: true,
          structuredOutput: false,
          jsonMode: false,
          toolChoice: true,
          parallelToolCalls: false,
          vision: false,
          files: false,
          audioInput: false,
          audioOutput: false,
          embeddings: false,
          reasoning: false,
          webSearch: false
        },
        async stream(input) {
          firstMessageText = input.messages[0]?.parts[0]?.type === "text" ? input.messages[0].parts[0].text : "";
          expect(input.structuredOutput).toBeUndefined();
          return (async function* (): AsyncGenerator<StreamEvent> {
            yield { type: "text-delta", textDelta: "{\"title\":\"Soup\"}" };
            yield { type: "finish", finishReason: "stop" };
          })();
        }
      }),
      prompt: "Generate recipe JSON",
      schema: z.object({
        title: z.string()
      })
    });

    const final = await result.collect();

    expect(firstMessageText).toBe("Generate recipe JSON\n\nReturn only valid JSON matching the requested schema.");
    expect(final.objectMode).toBe("prompted");
    expect(final.object).toEqual({ title: "Soup" });
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

  it("streams plain text through textStream", async () => {
    const result = streamText({
      model: createLanguageModel(),
      prompt: "Stream"
    });

    const chunks: string[] = [];
    for await (const chunk of result.textStream) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["hello", " world"]);
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
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, forecast: "sunny" })
        })
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
