import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createBatch,
  createContextCache,
  embedMany,
  fetchPredictionOperation,
  generateGroundedText,
  generateImage,
  generateMusic,
  generateObject,
  generateSpeech,
  generateText,
  generateVideo,
  googleComputerUseTool,
  googleUrlContextTool,
  hostedTool,
  predictLongRunning,
  predictRaw,
  tool,
  transcribeAudio
} from "@zhivex-ai/core";
import { runAgentProviderContractSuite } from "../../core/tests/agent-provider-contract.js";
import { runLanguageModelContractSuite } from "../../core/tests/provider-contract.js";
import { createVertex, vertexMcpTools } from "../src/index.js";

describe("vertex adapter", () => {
  const fetchMock = vi.fn();

  runLanguageModelContractSuite({
    providerName: "vertex",
    modelId: "gemini-2.0-flash",
    createModel: () =>
      createVertex({
        accessToken: "test",
        projectId: "demo-project",
        location: "us-central1",
        fetch: fetchMock as typeof fetch
      })("gemini-2.0-flash"),
    createEmbeddingModel: () =>
      createVertex({
        accessToken: "test",
        projectId: "demo-project",
        location: "us-central1",
        fetch: fetchMock as typeof fetch
      }).embeddingModel("text-embedding-005"),
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
      fileSearch: false,
      urlContext: true,
      contextCaching: true,
      batch: true,
      interactions: false,
      rawPrediction: true,
      computerUse: true,
      reasoning: true,
      webSearch: true
    }
  });

  runAgentProviderContractSuite({
    providerName: "vertex",
    modelId: "gemini-2.0-flash",
    expectedAgentTier: "tier-b",
    createModel: () =>
      createVertex({
        accessToken: "test",
        projectId: "demo-project",
        location: "us-central1",
        fetch: fetchMock as typeof fetch
      })("gemini-2.0-flash"),
    mockSimpleRun: () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          candidates: [
            {
              finishReason: "STOP",
              content: { parts: [{ text: "hello from vertex agent" }] }
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
            content: { parts: [{ text: "hello from vertex" }] }
          }
        ]
      })
    );

    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      location: "us-central1",
      fetch: fetchMock as typeof fetch
    });
    const result = await generateText({
      model: provider("gemini-2.0-flash"),
      prompt: "hello"
    });

    expect(result.text).toBe("hello from vertex");
    expect(result.finishReason).toBe("stop");
  });

  it("creates equivalent language models from the callable provider", () => {
    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      location: "us-central1",
      fetch: fetchMock as typeof fetch
    });

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

    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      location: "us-central1",
      fetch: fetchMock as typeof fetch
    });
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
        predictions: [{ embeddings: { values: [0.5, 0.6] } }, { embeddings: { values: [0.7, 0.8] } }]
      })
    );

    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      location: "us-central1",
      fetch: fetchMock as typeof fetch
    });
    const result = await embedMany({
      model: provider.embeddingModel("text-embedding-005"),
      value: ["hello", "world"]
    });

    expect(result.embeddings).toEqual([
      [0.5, 0.6],
      [0.7, 0.8]
    ]);
  });

  it("passes provider-specific options through to Vertex", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: "hello from vertex" }] }
          }
        ]
      })
    );

    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      location: "us-central1",
      fetch: fetchMock as typeof fetch
    });
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

  it("maps common tool choice to Vertex toolConfig", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: "hello from vertex" }] }
          }
        ]
      })
    );

    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      location: "us-central1",
      fetch: fetchMock as typeof fetch
    });
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

  it("maps hosted Vertex tools into native tool declarations", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: "hello from vertex" }] }
          }
        ]
      })
    );

    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      location: "us-central1",
      fetch: fetchMock as typeof fetch
    });
    await generateText({
      model: provider("gemini-2.0-flash"),
      prompt: "hello",
      tools: {
        google: hostedTool({
          name: "google",
          provider: "vertex",
          type: "googleSearch"
        }),
        code: hostedTool({
          name: "code",
          provider: "vertex",
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

  it("maps Google hosted tool helpers into Vertex native tool declarations", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: "ok" }] } }]
      })
    );

    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      location: "us-central1",
      fetch: fetchMock as typeof fetch
    });
    await generateText({
      model: provider("gemini-2.0-flash"),
      prompt: "read url",
      tools: {
        urls: googleUrlContextTool(),
        computer: googleComputerUseTool({ environment: "browser" })
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { tools: Array<Record<string, unknown>> };
    expect(body.tools).toEqual([{ urlContext: {} }, { computerUse: { environment: "browser" } }]);
  });

  it("creates Vertex context caches with full model resource paths", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        name: "projects/demo-project/locations/us-central1/cachedContents/cache-1",
        displayName: "Cache"
      })
    );

    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      location: "us-central1",
      fetch: fetchMock as typeof fetch
    });
    const cache = await createContextCache({
      provider,
      modelId: "gemini-2.0-flash",
      displayName: "Cache",
      contents: [{ role: "user", parts: [{ type: "text", text: "long context" }] }]
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1beta1/projects/demo-project/locations/us-central1/cachedContents"
    );
    expect(body.model).toBe("projects/demo-project/locations/us-central1/publishers/google/models/gemini-2.0-flash");
    expect(cache.name).toContain("cachedContents/cache-1");
  });

  it("creates Vertex batch jobs", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ name: "batches/1", metadata: { state: "JOB_STATE_PENDING" } }));

    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      location: "us-central1",
      fetch: fetchMock as typeof fetch
    });
    const batch = await createBatch({
      provider,
      modelId: "gemini-2.0-flash",
      displayName: "Batch",
      fileName: "files/batch-input"
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/publishers/google/models/gemini-2.0-flash:batchGenerateContent");
    expect(body.batch.inputConfig.fileName).toBe("files/batch-input");
    expect(batch.name).toBe("batches/1");
  });

  it("runs Vertex raw prediction and fetchPredictOperation", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ predictions: [{ label: "ok" }] }));
    fetchMock.mockResolvedValueOnce(Response.json({ name: "operations/1", done: false }));
    fetchMock.mockResolvedValueOnce(Response.json({ name: "operations/1", done: true, response: { ok: true } }));

    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      location: "us-central1",
      fetch: fetchMock as typeof fetch
    });
    const model = provider.predictionModel!("publisher-model");
    const raw = await predictRaw({ model, instances: [{ prompt: "hello" }] });
    const started = await predictLongRunning({ model, instances: [{ prompt: "video" }] });
    const done = await fetchPredictionOperation({ model, name: started.name });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/publishers/google/models/publisher-model:predict");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(":predictLongRunning");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain(":fetchPredictOperation");
    expect(raw.predictions).toEqual([{ label: "ok" }]);
    expect(done.done).toBe(true);
  });

  it("fails explicitly for Gemini-only provider resource surfaces on Vertex", async () => {
    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      location: "us-central1",
      fetch: fetchMock as typeof fetch
    });

    expect(provider.files).toBeUndefined();
    expect(provider.fileSearchStores).toBeUndefined();
    expect(provider.interactions).toBeUndefined();
  });

  it("builds callable tools from an MCP client", async () => {
    const tools = await vertexMcpTools({
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

  it("maps reasoning budget tokens to Vertex thinking config", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: "hello from vertex" }] }
          }
        ]
      })
    );

    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      location: "us-central1",
      fetch: fetchMock as typeof fetch
    });
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

  it("rejects reasoning effort for Vertex models earlier than Gemini 3", async () => {
    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      location: "us-central1",
      fetch: fetchMock as typeof fetch
    });

    await expect(
      generateText({
        model: provider("gemini-2.0-flash"),
        prompt: "hello",
        reasoning: {
          effort: "low"
        }
      })
    ).rejects.toThrow('Provider "vertex" does not support "reasoning.effort" for models earlier than Gemini 3.');
  });

  it("maps reasoning effort to Vertex Gemini 3 thinking level", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: "hello from vertex" }] }
          }
        ]
      })
    );

    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      location: "us-central1",
      fetch: fetchMock as typeof fetch
    });
    await generateText({
      model: provider("gemini-3.1-pro-preview"),
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

  it("rejects legacy reasoning budget tokens for Vertex Gemini 3 models", async () => {
    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      location: "us-central1",
      fetch: fetchMock as typeof fetch
    });

    await expect(
      generateText({
        model: provider("gemini-3.1-pro-preview"),
        prompt: "hello",
        reasoning: {
          budgetTokens: 512
        }
      })
    ).rejects.toThrow(
      'Provider "vertex" uses "reasoning.effort" for Gemini 3 models and does not support "reasoning.budgetTokens".'
    );
  });

  it("transcribes audio through the shared contract", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [
          {
            content: { parts: [{ text: "hello from vertex audio" }] }
          }
        ]
      })
    );

    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      location: "us-central1",
      fetch: fetchMock as typeof fetch
    });
    const result = await transcribeAudio({
      model: provider.transcriptionModel!("gemini-2.0-flash"),
      audio: {
        data: "aGVsbG8=",
        mediaType: "audio/wav"
      }
    });

    expect(result.text).toBe("hello from vertex audio");
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

    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      location: "us-central1",
      fetch: fetchMock as typeof fetch
    });
    const result = await generateSpeech({
      model: provider.speechModel!("gemini-2.5-flash-preview-tts"),
      input: "hello there"
    });

    expect(Array.from(result.audio)).toEqual([1, 2, 3]);
    expect(result.mediaType).toBe("audio/wav");
  });

  it("generates Gemini images through Vertex generateContent", async () => {
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

    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      location: "us-central1",
      fetch: fetchMock as typeof fetch
    });
    const result = await generateImage({
      model: provider.imageGenerationModel!("gemini-3.1-flash-image-preview"),
      prompt: "draw a banana",
      aspectRatio: "1:1",
      size: "1K"
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(":generateContent");
    expect(body.generationConfig.responseModalities).toEqual(["TEXT", "IMAGE"]);
    expect(Array.from(result.images[0]?.data ?? [])).toEqual([1, 2, 3]);
    expect(result.text).toBe("generated image");
  });

  it("generates Imagen images through Vertex predict", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        predictions: [
          {
            bytesBase64Encoded: "BAUG",
            mimeType: "image/png"
          }
        ]
      })
    );

    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      location: "us-central1",
      fetch: fetchMock as typeof fetch
    });
    const result = await generateImage({
      model: provider.imageGenerationModel!("imagen-4.0-generate-001"),
      prompt: "draw a banana",
      count: 2,
      outputMimeType: "image/png"
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(":predict");
    expect(body.instances[0].prompt).toBe("draw a banana");
    expect(body.parameters.number_of_images).toBe(2);
    expect(Array.from(result.images[0]?.data ?? [])).toEqual([4, 5, 6]);
  });

  it("generates Vertex Lyria audio through predict", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        predictions: [
          {
            audioContent: "Bw gJ".replace(" ", ""),
            mimeType: "audio/wav"
          }
        ]
      })
    );

    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      location: "us-central1",
      fetch: fetchMock as typeof fetch
    });
    const result = await generateMusic({
      model: provider.musicGenerationModel!("lyria-002"),
      prompt: "make a song"
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(":predict");
    expect(Array.from(result.audio[0]?.data ?? [])).toEqual([7, 8, 9]);
  });

  it("generates Veo videos through Vertex long-running operations", async () => {
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

    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      location: "us-central1",
      fetch: fetchMock as typeof fetch
    });
    const result = await generateVideo({
      model: provider.videoGenerationModel!("veo-3.1-generate-preview"),
      prompt: "make a video",
      pollIntervalMs: 0
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(":predictLongRunning");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(":fetchPredictOperation");
    expect(result.videos[0]?.uri).toBe("https://example.test/video.mp4");
  });

  it("generates grounded text with sources", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: "fresh vertex answer" }] },
            groundingMetadata: {
              groundingChunks: [
                {
                  web: {
                    title: "Vertex Source",
                    uri: "https://example.com/vertex",
                    snippet: "Snippet"
                  }
                }
              ]
            }
          }
        ]
      })
    );

    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      location: "us-central1",
      fetch: fetchMock as typeof fetch
    });
    const result = await generateGroundedText({
      model: provider.groundedLanguageModel!("gemini-2.0-flash"),
      prompt: "What happened today?"
    });

    expect(result.text).toBe("fresh vertex answer");
    expect(result.sources[0]?.url).toBe("https://example.com/vertex");
  });

  it("connects Vertex Live sessions using the documented BidiGenerateContent websocket", async () => {
    const sent: Record<string, unknown>[] = [];
    const connectionFactory = vi.fn(async (url: string, headers: Record<string, string>) => {
      expect(url).toBe(
        "wss://us-central1-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1beta1.PredictionService.BidiGenerateContent"
      );
      expect(headers).toMatchObject({
        authorization: "Bearer test"
      });
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

    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      location: "us-central1",
      fetch: fetchMock as typeof fetch,
      realtimeConnectionFactory: connectionFactory
    });
    const session = await provider.realtimeModel!("gemini-live-2.5-flash-native-audio").connect({
      instructions: "Be brief."
    });

    await session.sendMedia({ data: "vertex-image", mediaType: "image/jpeg" });
    await session.sendText("hello vertex");
    await session.close();

    expect(connectionFactory).toHaveBeenCalledOnce();
    expect(sent[0]).toMatchObject({
      setup: expect.objectContaining({
        model: "models/gemini-live-2.5-flash-native-audio"
      })
    });
    expect(sent[1]).toMatchObject({
      realtimeInput: {
        media: {
          mimeType: "image/jpeg",
          data: "vertex-image"
        }
      }
    });
    expect(sent[2]).toMatchObject({
      clientContent: {
        turns: [{ role: "user", parts: [{ text: "hello vertex" }] }],
        turnComplete: true
      }
    });
  });

  it("reports Vertex browser tokens as unsupported", async () => {
    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      location: "us-central1",
      fetch: fetchMock as typeof fetch
    });

    await expect(provider.realtimeModel!("gemini-live-2.5-flash-native-audio").createBrowserToken?.()).rejects.toThrow(
      "does not support browser session tokens"
    );
  });
});
