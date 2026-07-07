import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  audioPart,
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
      createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch }).embeddingModel("gemini-embedding-2"),
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
      audioInput: true,
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

  it("maps audio parts to Gemini inlineData for text generation", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: "the audio says hello" }] }
          }
        ]
      })
    );

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("gemini-3.5-flash"),
      messages: [
        {
          role: "user",
          parts: [
            { type: "text", text: "Transcribe the short clip." },
            audioPart({ mediaType: "audio/wav", data: new Uint8Array([1, 2, 3, 4]) })
          ]
        }
      ]
    });

    expect(result.text).toBe("the audio says hello");
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    expect(body.contents[0]?.parts).toEqual([
      { text: "Transcribe the short clip." },
      {
        inlineData: {
          mimeType: "audio/wav",
          data: "AQIDBA=="
        }
      }
    ]);
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

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      generationConfig: { responseSchema: Record<string, unknown> };
    };
    expect(body.generationConfig.responseSchema).toMatchObject({
      type: "object",
      properties: {
        title: { type: "string" },
        servings: { type: "number" }
      },
      required: ["title", "servings"]
    });
    expect(JSON.stringify(body.generationConfig.responseSchema)).not.toContain("$schema");
    expect(JSON.stringify(body.generationConfig.responseSchema)).not.toContain("additionalProperties");
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
      model: provider.embeddingModel("gemini-embedding-2"),
      value: ["hello", "world"]
    });

    expect(result.embeddings).toEqual([
      [0.5, 0.6],
      [0.7, 0.8]
    ]);
    const firstBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      content: { parts: Array<Record<string, unknown>> };
    };
    expect(firstBody.content.parts).toEqual([{ text: "hello" }]);
  });

  it("embeds inline media with gemini-embedding-2", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        embedding: { values: [0.1, 0.2] }
      })
    );

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await embedMany({
      model: provider.embeddingModel("gemini-embedding-2"),
      value: [{ data: new Uint8Array([5, 6, 7]), mediaType: "image/png" }]
    });

    expect(result.embeddings).toEqual([[0.1, 0.2]]);
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      content: { parts: Array<Record<string, unknown>> };
    };
    expect(body.content.parts).toEqual([
      {
        inlineData: {
          mimeType: "image/png",
          data: "BQYH"
        }
      }
    ]);
  });

  it("embeds file media with gemini-embedding-2", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        embedding: { values: [0.3, 0.4] }
      })
    );

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await embedMany({
      model: provider.embeddingModel("gemini-embedding-2"),
      value: [{ uri: "gs://bucket/sample.wav", mediaType: "audio/wav" }]
    });

    expect(result.embeddings).toEqual([[0.3, 0.4]]);
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      content: { parts: Array<Record<string, unknown>> };
    };
    expect(body.content.parts).toEqual([
      {
        fileData: {
          mimeType: "audio/wav",
          fileUri: "gs://bucket/sample.wav"
        }
      }
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
      tools: Array<{ functionDeclarations: Array<{ parameters: Record<string, unknown> }> }>;
    };
    expect(body.toolConfig).toEqual({
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: ["weather"]
      }
    });
    const schemaJson = JSON.stringify(body.tools[0]?.functionDeclarations[0]?.parameters);
    expect(schemaJson).toContain("\"city\"");
    expect(schemaJson).not.toContain("$schema");
    expect(schemaJson).not.toContain("additionalProperties");
  });

  it("preserves Gemini thought signatures and ids across local tool loops", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [
                {
                  functionCall: {
                    id: "call-1",
                    name: "sum",
                    args: { a: 2, b: 3 }
                  },
                  thoughtSignature: "signature-1"
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
            content: { parts: [{ text: "5" }] }
          }
        ]
      })
    );

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("gemini-3.5-flash"),
      prompt: "add numbers",
      maxSteps: 2,
      tools: {
        sum: tool({
          name: "sum",
          schema: z.object({ a: z.number(), b: z.number() }),
          execute: ({ a, b }) => ({ total: a + b })
        })
      },
      toolChoice: {
        type: "tool",
        toolName: "sum"
      }
    });

    const firstRequestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const firstBody = JSON.parse(String(firstRequestInit.body)) as {
      toolConfig: { functionCallingConfig: { mode: string; allowedFunctionNames: string[] } };
    };
    const secondRequestInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const body = JSON.parse(String(secondRequestInit.body)) as {
      toolConfig?: unknown;
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    };

    expect(result.text).toBe("5");
    expect(firstBody.toolConfig).toEqual({
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: ["sum"]
      }
    });
    expect(body.toolConfig).toBeUndefined();
    expect(body.contents[1]?.parts[0]).toMatchObject({
      functionCall: {
        id: "call-1",
        name: "sum",
        args: { a: 2, b: 3 }
      },
      thoughtSignature: "signature-1"
    });
    expect(body.contents[2]?.parts[0]).toMatchObject({
      functionResponse: {
        id: "call-1",
        name: "sum",
        response: {
          name: "sum",
          content: { total: 5 }
        }
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

  it("maps Gemini computer use tools to the Interactions API shape", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "int-1",
        model: "gemini-3.5-flash",
        outputs: [
          {
            function_call: {
              name: "computer_use",
              args: {
                action: "click",
                x: 120,
                y: 240,
                intent: "press the submit button"
              }
            }
          }
        ]
      })
    );

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const interaction = await createInteraction({
      provider,
      modelId: "gemini-3.5-flash",
      input: "Open the checkout page and submit the form.",
      tools: {
        computer: googleComputerUseTool({ screen: "browser" })
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      model: string;
      tools: Array<Record<string, unknown>>;
    };

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/interactions?key=test");
    expect(body.model).toBe("gemini-3.5-flash");
    expect(body.tools).toEqual([{ type: "computer_use", environment: "browser" }]);
    expect(interaction.outputs?.[0]).toMatchObject({
      function_call: {
        name: "computer_use",
        args: {
          intent: "press the submit button"
        }
      }
    });
  });

  it("streams Gemini computer use actions as provider data for browser loops", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"output":{"function_call":{"name":"computer_use","args":{"action":"click","x":120,"y":240,"intent":"press submit"}}}}\n\n' +
              'data: {"status":"completed"}\n\n'
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
    const stream = await provider.interactions!.stream({
      modelId: "gemini-3.5-flash",
      input: [{ screenshot: "data:image/png;base64,abc123" }],
      previousInteractionId: "int-1",
      tools: {
        computer: googleComputerUseTool({ environment: "browser" })
      }
    });

    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const requestBody = JSON.parse(String(requestInit.body)) as {
      previous_interaction_id: string;
      tools: Array<Record<string, unknown>>;
    };

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/interactions?key=test&alt=sse");
    expect(requestBody.previous_interaction_id).toBe("int-1");
    expect(requestBody.tools).toEqual([{ type: "computer_use", environment: "browser" }]);
    expect(events).toContainEqual({
      type: "provider-data",
      provider: "gemini",
      data: {
        output: {
          function_call: {
            name: "computer_use",
            args: {
              action: "click",
              x: 120,
              y: 240,
              intent: "press submit"
            }
          }
        }
      }
    });
    expect(events.at(-1)).toEqual({ type: "finish", finishReason: "stop" });
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
      model: provider.speechModel!("gemini-3.1-flash-tts-preview"),
      input: "hello there"
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.generationConfig).toMatchObject({
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: "Kore" }
        }
      }
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
      model: provider.imageGenerationModel!("gemini-3.1-flash-image"),
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
      expect(url).toContain("/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent");
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
    const session = await provider.realtimeModel!("gemini-3.1-flash-live-preview").connect({
      instructions: "Be brief.",
      reasoning: { effort: "low", includeThoughts: true },
      inputAudioTranscription: true,
      outputAudioTranscription: true,
      mediaResolution: "MEDIA_RESOLUTION_LOW",
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: () => ({ ok: true })
        })
      },
      outputAudioMediaType: "audio/pcm",
      providerOptions: { apiVersion: "v1alpha" }
    });

    await session.sendMedia({ data: "image-bytes", mediaType: "image/jpeg" });
    await session.sendText("hello gemini");
    await session.close();

    expect(connectionFactory).toHaveBeenCalledOnce();
    expect(sent[0]).toMatchObject({
      setup: expect.objectContaining({
        model: "models/gemini-3.1-flash-live-preview",
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        mediaResolution: "MEDIA_RESOLUTION_LOW",
        generationConfig: expect.objectContaining({
          responseModalities: ["AUDIO"],
          thinkingConfig: { thinkingLevel: "low", includeThoughts: true }
        }),
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
      realtimeInput: {
        text: "hello gemini"
      }
    });
  });

  it("rejects Gemini 3.1 Live affective dialog and proactive audio before connecting", async () => {
    const connectionFactory = vi.fn();
    const provider = createGemini({
      apiKey: "test",
      fetch: fetchMock as typeof fetch,
      realtimeConnectionFactory: connectionFactory
    });
    const model = provider.realtimeModel!("gemini-3.1-flash-live-preview");

    await expect(model.connect({ affectiveDialog: true })).rejects.toThrow(/affectiveDialog/);
    await expect(model.connect({ proactiveAudio: true })).rejects.toThrow(/proactiveAudio/);
    expect(connectionFactory).not.toHaveBeenCalled();
  });

  it("connects Gemini 3.5 Live Translate sessions with typed translation config", async () => {
    const sent: Record<string, unknown>[] = [];
    const connectionFactory = vi.fn(async (url: string, headers: Record<string, string>) => {
      expect(url).toContain("/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent");
      expect(headers).toEqual({});
      let read = false;
      return {
        async sendJson(payload: Record<string, unknown>) {
          sent.push(payload);
        },
        async recvJson() {
          if (read) {
            return undefined;
          }
          read = true;
          return {
            serverContent: {
              modelTurn: {
                parts: [
                  {
                    inlineData: {
                      mimeType: "audio/pcm",
                      data: "AQID"
                    }
                  }
                ]
              },
              outputTranscription: { text: "czesc" },
              turnComplete: true
            }
          };
        },
        async close() {}
      };
    });

    const provider = createGemini({
      apiKey: "test",
      fetch: fetchMock as typeof fetch,
      realtimeConnectionFactory: connectionFactory
    });
    const session = await provider.realtimeModel!("gemini-3.5-live-translate-preview").connect({
      mode: "translation",
      translation: {
        sourceLanguage: "en",
        targetLanguage: "pl"
      },
      inputAudioTranscription: true,
      outputAudioTranscription: true,
      outputAudioMediaType: "audio/pcm",
      providerOptions: {
        apiVersion: "v1alpha",
        translationConfig: {
          echoTargetLanguage: true
        }
      }
    });

    await session.sendAudio({ data: "audio-bytes", mediaType: "audio/pcm" });
    await session.close();

    expect(connectionFactory).toHaveBeenCalledOnce();
    expect(sent[0]).toMatchObject({
      setup: {
        model: "models/gemini-3.5-live-translate-preview",
        generationConfig: {
          responseModalities: ["AUDIO"]
        },
        translationConfig: {
          sourceLanguageCode: "en",
          targetLanguageCode: "pl",
          echoTargetLanguage: true
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {}
      }
    });
    expect(sent[0]?.setup).not.toHaveProperty("tools");
    expect(sent[1]).toMatchObject({
      realtimeInput: {
        audio: {
          mimeType: "audio/pcm",
          data: "audio-bytes"
        }
      }
    });

    const events = [];
    for await (const event of session.eventStream()) {
      events.push(event);
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "realtime-audio-output",
        mediaType: "audio/pcm",
        audio: Buffer.from([1, 2, 3])
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "realtime-transcript",
        role: "assistant",
        text: "czesc",
        isFinal: true
      })
    );
  });

  it("rejects unsupported Gemini 3.5 Live Translate setup and inputs", async () => {
    const sent: Record<string, unknown>[] = [];
    const connectionFactory = vi.fn(async () => ({
      async sendJson(payload: Record<string, unknown>) {
        sent.push(payload);
      },
      async recvJson() {
        return undefined;
      },
      async close() {}
    }));
    const provider = createGemini({
      apiKey: "test",
      fetch: fetchMock as typeof fetch,
      realtimeConnectionFactory: connectionFactory
    });

    await expect(provider.realtimeModel!("gemini-3.5-live-translate-preview").connect()).rejects.toThrow(
      'Model "gemini/gemini-3.5-live-translate-preview" requires "translation.targetLanguage".'
    );
    await expect(
      provider.realtimeModel!("gemini-3.5-live-translate-preview").connect({
        mode: "conversation",
        translation: { targetLanguage: "pl" }
      })
    ).rejects.toThrow('Model "gemini/gemini-3.5-live-translate-preview" only supports realtime translation mode.');
    await expect(
      provider.realtimeModel!("gemini-3.5-live-translate-preview").connect({
        translation: { targetLanguage: "pl" },
        reasoning: { effort: "low" }
      })
    ).rejects.toThrow('Model "gemini/gemini-3.5-live-translate-preview" does not support realtime reasoning.');
    await expect(
      provider.realtimeModel!("gemini-3.5-live-translate-preview").connect({
        translation: { targetLanguage: "pl" },
        tools: {
          weather: tool({
            name: "weather",
            schema: z.object({ city: z.string() }),
            execute: () => ({ ok: true })
          })
        }
      })
    ).rejects.toThrow('Model "gemini/gemini-3.5-live-translate-preview" does not support realtime tools.');

    const session = await provider.realtimeModel!("gemini-3.5-live-translate-preview").connect({
      translation: { targetLanguage: "pl" }
    });

    await expect(session.sendText("hello")).rejects.toThrow(
      'Model "gemini/gemini-3.5-live-translate-preview" only supports audio input.'
    );
    await expect(session.sendMedia({ data: "image", mediaType: "image/jpeg" })).rejects.toThrow(
      'Model "gemini/gemini-3.5-live-translate-preview" only supports audio input.'
    );
    expect(sent).toHaveLength(1);
    await session.close();
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
