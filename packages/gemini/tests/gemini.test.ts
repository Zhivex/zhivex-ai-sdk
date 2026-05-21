import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  embedMany,
  createBatch,
  createContextCache,
  createFileSearchStore,
  createInteraction,
  deleteFile,
  fetchPredictionOperation,
  generateGroundedText,
  generateImage,
  generateMusic,
  generateObject,
  generateSpeech,
  generateText,
  generateVideo,
  getContextCache,
  googleComputerUseTool,
  googleFileSearchTool,
  googleUrlContextTool,
  hostedTool,
  importFileToFileSearchStore,
  predictLongRunning,
  predictRaw,
  streamText,
  uploadFile,
  tool,
  transcribeAudio
} from "@zhivex-ai/core";
import { runAgentProviderContractSuite } from "../../core/tests/agent-provider-contract.js";
import { runLanguageModelContractSuite } from "../../core/tests/provider-contract.js";
import { createGemini, geminiMcpTools } from "../src/index.js";

describe("gemini adapter", () => {
  const fetchMock = vi.fn();

  runLanguageModelContractSuite({
    providerName: "gemini",
    modelId: "gemini-3.5-flash",
    createModel: () => createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch })("gemini-3.5-flash"),
    createEmbeddingModel: () =>
      createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch }).embeddingModel("text-embedding-004"),
    expectedAgentTier: "tier-b",
    expectedCapabilities: {
      streaming: true,
      tools: true,
      structuredOutput: true,
      jsonMode: true,
      toolChoice: true,
      parallelToolCalls: false,
      vision: true,
      files: true,
      audioInput: false,
      audioOutput: false,
      embeddings: true,
      fileSearch: true,
      urlContext: true,
      contextCaching: true,
      batch: true,
      interactions: true,
      rawPrediction: true,
      computerUse: true,
      reasoning: true,
      webSearch: true
    }
  });

  runAgentProviderContractSuite({
    providerName: "gemini",
    modelId: "gemini-3.5-flash",
    expectedAgentTier: "tier-b",
    createModel: () => createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch })("gemini-3.5-flash"),
    mockSimpleRun: () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          candidates: [
            {
              finishReason: "STOP",
              content: { parts: [{ text: "hello from gemini agent" }] }
            }
          ]
        })
      );
    },
    mockToolRun: () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      id: "tool-1",
                      name: "weather",
                      args: { city: "Madrid" }
                    }
                  }
                ]
              }
            }
          ]
        })
      );
      fetchMock.mockResolvedValueOnce(
        Response.json({
          candidates: [
            {
              finishReason: "STOP",
              content: { parts: [{ text: "Madrid is sunny" }] }
            }
          ]
        })
      );
    },
    mockStreamRun: () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hello\"}]}}]}\n\n" +
                "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\" world\"}]},\"finishReason\":\"STOP\"}]}\n\n"
            )
          );
          controller.close();
        }
      });

      fetchMock.mockResolvedValueOnce(
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        })
      );
    }
  });

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("maps generated text into the common contract", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: "hello from gemini" }] }
          }
        ]
      })
    );

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("gemini-2.0-flash"),
      prompt: "hello"
    });

    expect(result.text).toBe("hello from gemini");
    expect(result.finishReason).toBe("stop");
  });

  it("creates equivalent language models from the callable provider", () => {
    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });

    expect(provider("gemini-2.0-flash")).toMatchObject(provider.languageModel("gemini-2.0-flash"));
  });

  it("supports structured output on top of provider text", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: JSON.stringify({ title: "Tea", servings: 1 }) }] }
          }
        ]
      })
    );

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateObject({
      model: provider("gemini-2.0-flash"),
      prompt: "Return JSON",
      schema: z.object({
        title: z.string(),
        servings: z.number()
      }),
      mode: "native"
    });

    expect(result.object.title).toBe("Tea");
    expect(result.objectMode).toBe("native");
  });

  it("embeds content in batches", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        embedding: { values: [0.5, 0.6] }
      })
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({
        embedding: { values: [0.7, 0.8] }
      })
    );

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await embedMany({
      model: provider.embeddingModel("text-embedding-004"),
      value: ["hello", "world"]
    });

    expect(result.embeddings).toEqual([
      [0.5, 0.6],
      [0.7, 0.8]
    ]);
  });

  it("passes provider-specific options through to the Gemini API", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: "hello from gemini" }] }
          }
        ]
      })
    );

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("gemini-2.0-flash"),
      prompt: "hello",
      providerOptions: {
        topP: 0.95,
        candidateCount: 1
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { topP: number; candidateCount: number };
    expect(body.topP).toBe(0.95);
    expect(body.candidateCount).toBe(1);
  });

  it("maps common tool choice to Gemini toolConfig", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: "hello from gemini" }] }
          }
        ]
      })
    );

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("gemini-2.0-flash"),
      prompt: "hello",
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city })
        })
      },
      toolChoice: {
        type: "tool",
        toolName: "weather"
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      toolConfig: { functionCallingConfig: { mode: string; allowedFunctionNames: string[] } };
    };
    expect(body.toolConfig).toEqual({
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: ["weather"]
      }
    });
  });

  it("maps hosted Gemini tools into native tool declarations", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: "hello from gemini" }] }
          }
        ]
      })
    );

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("gemini-2.0-flash"),
      prompt: "hello",
      tools: {
        google: hostedTool({
          name: "google",
          provider: "gemini",
          type: "googleSearch"
        }),
        code: hostedTool({
          name: "code",
          provider: "gemini",
          type: "codeExecution"
        })
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      tools: Array<Record<string, unknown>>;
    };
    expect(body.tools).toEqual([{ googleSearch: {} }, { codeExecution: {} }]);
  });

  it("maps Google hosted tool helpers into Gemini native tool declarations", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: "ok" }] } }]
      })
    );

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("gemini-2.0-flash"),
      prompt: "read sources",
      tools: {
        urls: googleUrlContextTool(),
        files: googleFileSearchTool(["fileSearchStores/demo"]),
        computer: googleComputerUseTool({ environment: "browser" })
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { tools: Array<Record<string, unknown>> };
    expect(body.tools).toEqual([
      { urlContext: {} },
      { fileSearch: { fileSearchStoreNames: ["fileSearchStores/demo"] } },
      { computerUse: { environment: "browser" } }
    ]);
  });

  it("uploads, reads, and deletes files through the Gemini Files API", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        {},
        {
          headers: {
            "x-goog-upload-url": "https://upload.example.test/session"
          }
        }
      )
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({
        file: {
          name: "files/abc",
          uri: "https://files.example.test/abc",
          mimeType: "text/plain",
          displayName: "notes.txt"
        }
      })
    );
    fetchMock.mockResolvedValueOnce(Response.json({ name: "files/abc", uri: "https://files.example.test/abc" }));
    fetchMock.mockResolvedValueOnce(Response.json({}));

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const uploaded = await uploadFile({
      provider,
      data: "hello",
      mediaType: "text/plain",
      displayName: "notes.txt"
    });
    const read = await provider.files!.get({ name: "files/abc" });
    const deleted = await deleteFile({ provider, name: "files/abc" });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/upload/v1beta/files?key=test");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://upload.example.test/session");
    expect(uploaded.name).toBe("files/abc");
    expect(read.uri).toBe("https://files.example.test/abc");
    expect(deleted.name).toBe("files/abc");
  });

  it("creates file search stores and imports files with operation polling", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ name: "fileSearchStores/demo", displayName: "Demo" }));
    fetchMock.mockResolvedValueOnce(Response.json({ name: "operations/import-1", done: false }));
    fetchMock.mockResolvedValueOnce(Response.json({ name: "operations/import-1", done: true, response: { ok: true } }));

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const store = await createFileSearchStore({ provider, displayName: "Demo" });
    const operation = await importFileToFileSearchStore({
      provider,
      storeName: store.name,
      fileName: "files/abc",
      pollIntervalMs: 0
    });

    expect(store.name).toBe("fileSearchStores/demo");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("fileSearchStores/demo:importFile");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("/operations/import-1?key=test");
    expect(operation.done).toBe(true);
  });

  it("creates and reads Gemini context caches", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        name: "cachedContents/cache-1",
        model: "models/gemini-2.0-flash",
        displayName: "Cache"
      })
    );
    fetchMock.mockResolvedValueOnce(Response.json({ name: "cachedContents/cache-1", displayName: "Cache" }));

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const cache = await createContextCache({
      provider,
      modelId: "gemini-2.0-flash",
      displayName: "Cache",
      contents: [{ role: "user", parts: [{ type: "text", text: "long context" }] }]
    });
    const read = await getContextCache({ provider, name: cache.name });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/cachedContents?key=test");
    expect(body.model).toBe("models/gemini-2.0-flash");
    expect(read.name).toBe("cachedContents/cache-1");
  });

  it("uses cachedContent provider options in Gemini generateContent", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ candidates: [{ content: { parts: [{ text: "cached answer" }] } }] }));

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("gemini-2.0-flash"),
      prompt: "use cache",
      providerOptions: {
        cachedContent: "cachedContents/cache-1"
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body));
    expect(body.cachedContent).toBe("cachedContents/cache-1");
  });

  it("creates Gemini batch jobs", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ name: "batches/1", metadata: { state: "JOB_STATE_PENDING" } }));

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const batch = await createBatch({
      provider,
      modelId: "gemini-2.0-flash",
      displayName: "Batch",
      requests: [{ request: { contents: [{ parts: [{ text: "hello" }] }] }, metadata: { key: "1" } }]
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/models/gemini-2.0-flash:batchGenerateContent?key=test");
    expect(body.batch.inputConfig.requests.requests[0].metadata.key).toBe("1");
    expect(batch.name).toBe("batches/1");
  });

  it("creates, gets, and streams Gemini interactions", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ id: "int-1", model: "gemini-3.5-flash", outputs: [{ text: "hello" }] }));
    fetchMock.mockResolvedValueOnce(Response.json({ id: "int-1", status: "completed" }));
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {\"text\":\"hel\"}\n\ndata: {\"text\":\"lo\",\"status\":\"completed\"}\n\n"));
        controller.close();
      }
    });
    fetchMock.mockResolvedValueOnce(
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      })
    );

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const interaction = await createInteraction({
      provider,
      modelId: "gemini-3.5-flash",
      input: "hello"
    });
    const read = await provider.interactions!.get({ id: interaction.id });
    const stream = await provider.interactions!.stream({ modelId: "gemini-3.5-flash", input: "hello" });
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/interactions?key=test");
    expect(read.status).toBe("completed");
    expect(events.filter((event) => event.type === "text-delta").map((event: any) => event.textDelta).join("")).toBe("hello");
  });

  it("runs Gemini raw prediction helpers and operation fetches", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ predictions: [{ ok: true }] }));
    fetchMock.mockResolvedValueOnce(Response.json({ name: "operations/1", done: false }));
    fetchMock.mockResolvedValueOnce(Response.json({ name: "operations/1", done: true, response: { ok: true } }));

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const model = provider.predictionModel!("custom-model");
    const raw = await predictRaw({ model, instances: [{ prompt: "hi" }] });
    const started = await predictLongRunning({ model, instances: [{ prompt: "video" }] });
    const done = await fetchPredictionOperation({ model, name: started.name });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/models/custom-model:predict?key=test");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(":predictLongRunning");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("/operations/1?key=test");
    expect(raw.predictions).toEqual([{ ok: true }]);
    expect(done.done).toBe(true);
  });

  it("builds callable tools from an MCP client", async () => {
    const tools = await geminiMcpTools({
      async listTools() {
        return {
          tools: [
            {
              name: "echo",
              description: "Echo a value"
            }
          ]
        };
      },
      async callTool(input) {
        return {
          content: [{ type: "text", text: "ok" }],
          structuredContent: {
            echoed: input.arguments
          }
        };
      }
    });

    const echo = tools.echo;
    if (!echo || !("execute" in echo)) {
      throw new Error("Expected MCP tool to be callable.");
    }

    await expect(echo.execute({ value: 42 })).resolves.toEqual({
      content: [{ type: "text", text: "ok" }],
      structuredContent: {
        echoed: { value: 42 }
      }
    });
  });

  it("maps reasoning budget tokens to Gemini thinking config", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: "hello from gemini" }] }
          }
        ]
      })
    );

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("gemini-2.0-flash"),
      prompt: "hello",
      reasoning: {
        budgetTokens: 512
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      generationConfig: { thinkingConfig: { thinkingBudget: number } };
    };
    expect(body.generationConfig.thinkingConfig).toEqual({
      thinkingBudget: 512
    });
  });

  it("rejects reasoning effort for Gemini models earlier than Gemini 3", async () => {
    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("gemini-2.0-flash"),
        prompt: "hello",
        reasoning: {
          effort: "low"
        }
      })
    ).rejects.toThrow('Provider "gemini" does not support "reasoning.effort" for models earlier than Gemini 3.');
  });

  it("maps reasoning effort to Gemini 3 thinking level", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: "hello from gemini" }] }
          }
        ]
      })
    );

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("gemini-3.5-flash"),
      prompt: "hello",
      reasoning: {
        effort: "low"
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      generationConfig: { thinkingConfig: { thinkingLevel: string } };
    };
    expect(body.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "low"
    });
  });

  it("rejects legacy reasoning budget tokens for Gemini 3 models", async () => {
    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("gemini-3.5-flash"),
        prompt: "hello",
        reasoning: {
          budgetTokens: 512
        }
      })
    ).rejects.toThrow(
      'Provider "gemini" uses "reasoning.effort" for Gemini 3 models and does not support "reasoning.budgetTokens".'
    );
  });

  it("uses the Gemini streaming endpoint with alt=sse before the api key", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hello\"}]}}]}\n\n" +
              "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\" world\"}]},\"finishReason\":\"STOP\"}]}\n\n"
          )
        );
        controller.close();
      }
    });

    fetchMock.mockResolvedValueOnce(
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      })
    );

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("gemini-2.0-flash"),
      prompt: "hello"
    });

    expect((await result.collect()).text).toBe("hello world");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=test"
    );
  });

  it("parses Gemini SSE streams with CRLF separators across chunk boundaries", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode("data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hello\"}]}}]}\r")
        );
        controller.enqueue(
          encoder.encode(
            "\n\r\ndata: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\" world\"}]},\"finishReason\":\"STOP\"}]}\r\n\r\n"
          )
        );
        controller.close();
      }
    });

    fetchMock.mockResolvedValueOnce(
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      })
    );

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("gemini-2.0-flash"),
      prompt: "hello"
    });

    await expect(result.collect()).resolves.toMatchObject({
      text: "hello world",
      finishReason: "stop"
    });
  });

  it("transcribes audio through the shared contract", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [
          {
            content: { parts: [{ text: "hello from gemini audio" }] }
          }
        ]
      })
    );

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await transcribeAudio({
      model: provider.transcriptionModel!("gemini-2.0-flash"),
      audio: {
        data: "aGVsbG8=",
        mediaType: "audio/wav"
      }
    });

    expect(result.text).toBe("hello from gemini audio");
  });

  it("generates speech through the shared contract", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: "audio/wav",
                    data: "AQID"
                  }
                }
              ]
            }
          }
        ]
      })
    );

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateSpeech({
      model: provider.speechModel!("gemini-2.5-flash-preview-tts"),
      input: "hello there"
    });

    expect(Array.from(result.audio)).toEqual([1, 2, 3]);
    expect(result.mediaType).toBe("audio/wav");
  });

  it("generates images through Gemini generateContent", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [
          {
            content: {
              parts: [
                { text: "generated image" },
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: "AQID"
                  }
                }
              ]
            }
          }
        ]
      })
    );

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateImage({
      model: provider.imageGenerationModel!("gemini-3.1-flash-image-preview"),
      prompt: "draw a banana",
      aspectRatio: "1:1",
      size: "1K"
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body));
    expect(body.generationConfig.responseModalities).toEqual(["TEXT", "IMAGE"]);
    expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: "1:1", imageSize: "1K" });
    expect(Array.from(result.images[0]?.data ?? [])).toEqual([1, 2, 3]);
    expect(result.text).toBe("generated image");
  });

  it("generates Lyria 3 music through Gemini generateContent", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [
          {
            content: {
              parts: [
                { text: "lyrics" },
                {
                  inlineData: {
                    mimeType: "audio/mpeg",
                    data: "BAUG"
                  }
                }
              ]
            }
          }
        ]
      })
    );

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateMusic({
      model: provider.musicGenerationModel!("lyria-3-clip-preview"),
      prompt: "make a short song"
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body));
    expect(body.generationConfig.responseModalities).toEqual(["AUDIO", "TEXT"]);
    expect(Array.from(result.audio[0]?.data ?? [])).toEqual([4, 5, 6]);
    expect(result.text).toBe("lyrics");
  });

  it("generates Veo videos through Gemini long-running operations", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ name: "operations/veo-1", done: false }));
    fetchMock.mockResolvedValueOnce(
      Response.json({
        name: "operations/veo-1",
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [
              {
                video: {
                  uri: "https://example.test/video.mp4",
                  mimeType: "video/mp4"
                }
              }
            ]
          }
        }
      })
    );

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateVideo({
      model: provider.videoGenerationModel!("veo-3.1-generate-preview"),
      prompt: "make a video",
      pollIntervalMs: 0
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(":predictLongRunning");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/operations/veo-1?key=test");
    expect(result.videos[0]?.uri).toBe("https://example.test/video.mp4");
  });

  it("generates grounded text with sources", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: "fresh grounded answer" }] },
            groundingMetadata: {
              groundingChunks: [
                {
                  web: {
                    title: "Gemini Source",
                    uri: "https://example.com/gemini",
                    snippet: "Snippet"
                  }
                }
              ]
            }
          }
        ]
      })
    );

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateGroundedText({
      model: provider.groundedLanguageModel!("gemini-2.0-flash"),
      prompt: "What happened today?"
    });

    expect(result.text).toBe("fresh grounded answer");
    expect(result.sources[0]?.url).toBe("https://example.com/gemini");
  });

  it("connects Gemini Live sessions using the websocket endpoint and setup payload", async () => {
    const sent: Record<string, unknown>[] = [];
    const connectionFactory = vi.fn(async (url: string, headers: Record<string, string>) => {
      expect(url).toContain("/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent");
      expect(url).toContain("key=test");
      expect(headers).toEqual({});
      return {
        async sendJson(payload: Record<string, unknown>) {
          sent.push(payload);
        },
        async recvJson() {
          return undefined;
        },
        async close() {}
      };
    });

    const provider = createGemini({
      apiKey: "test",
      fetch: fetchMock as typeof fetch,
      realtimeConnectionFactory: connectionFactory
    });
    const session = await provider.realtimeModel!("gemini-live-2.5-flash-native-audio").connect({
      instructions: "Be brief.",
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: () => ({ ok: true })
        })
      },
      outputAudioMediaType: "audio/pcm"
    });

    await session.sendMedia({ data: "image-bytes", mediaType: "image/jpeg" });
    await session.sendText("hello gemini");
    await session.close();

    expect(connectionFactory).toHaveBeenCalledOnce();
    expect(sent[0]).toMatchObject({
      setup: expect.objectContaining({
        model: "models/gemini-live-2.5-flash-native-audio",
        tools: [expect.any(Object)]
      })
    });
    expect(sent[1]).toMatchObject({
      realtimeInput: {
        media: {
          mimeType: "image/jpeg",
          data: "image-bytes"
        }
      }
    });
    expect(sent[2]).toMatchObject({
      clientContent: {
        turns: [{ role: "user", parts: [{ text: "hello gemini" }] }],
        turnComplete: true
      }
    });
  });

  it("creates Gemini ephemeral browser tokens for Live API sessions", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        authToken: {
          name: "ephemeral-token",
          expireTime: "2026-04-15T00:00:00Z"
        }
      })
    );

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const token = await provider.realtimeModel!("gemini-live-2.5-flash-native-audio").createBrowserToken?.();

    expect(token?.value).toBe("ephemeral-token");
    expect(typeof token?.expiresAtMs).toBe("number");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v1alpha/authTokens?key=test");
  });
});
