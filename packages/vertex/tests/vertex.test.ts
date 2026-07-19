import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const googleAuthMockState = ((globalThis as any).__vertexGoogleAuthMockState ??= {
  instances: [] as Array<{
    options: Record<string, unknown>;
    getAccessToken: ReturnType<typeof vi.fn>;
  }>,
  nextToken: "adc-token" as string | null | undefined
});

vi.mock("google-auth-library", () => ({
  GoogleAuth: vi.fn(function GoogleAuth(options: Record<string, unknown>) {
    const state = ((globalThis as any).__vertexGoogleAuthMockState ??= {
      instances: [],
      nextToken: "adc-token"
    });
    const instance = {
      options,
      getAccessToken: vi.fn(async () => state.nextToken)
    };
    state.instances.push(instance);
    return instance;
  })
}));

import {
  audioPart,
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
  googleMapsTool,
  googleUrlContextTool,
  hostedTool,
  predictLongRunning,
  predictRaw,
  streamSpeech,
  streamText,
  tool,
  transcribeAudio
} from "@zhivex-ai/core";
import { runAgentProviderContractSuite } from "../../core/tests/agent-provider-contract.js";
import { runLanguageModelContractSuite } from "../../core/tests/provider-contract.js";
import { createVertex, vertexMcpTools } from "../src/index.js";

const vertexEnvKeys = [
  "VERTEX_ACCESS_TOKEN",
  "GOOGLE_ACCESS_TOKEN",
  "VERTEX_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "VERTEX_LOCATION",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_APPLICATION_CREDENTIALS"
];

const withVertexEnv = async (env: Record<string, string | undefined>, run: () => Promise<void>) => {
  const original = new Map(vertexEnvKeys.map((key) => [key, process.env[key]]));
  for (const key of vertexEnvKeys) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await run();
  } finally {
    for (const key of vertexEnvKeys) {
      const value = original.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

describe("vertex adapter", () => {
  const fetchMock = vi.fn();

  runLanguageModelContractSuite({
    providerName: "vertex",
    modelId: "gemini-3.5-flash",
    createModel: () =>
      createVertex({
        accessToken: "test",
        projectId: "demo-project",
        location: "us-central1",
        fetch: fetchMock as typeof fetch
      })("gemini-3.5-flash"),
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
      audioInput: true,
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
    modelId: "gemini-3.5-flash",
    expectedAgentTier: "tier-b",
    createModel: () =>
      createVertex({
        accessToken: "test",
        projectId: "demo-project",
        location: "us-central1",
        fetch: fetchMock as typeof fetch
      })("gemini-3.5-flash"),
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
    googleAuthMockState.instances.length = 0;
    googleAuthMockState.nextToken = "adc-token";
  });

  it("rejects oversized Vertex JSON responses before buffering them", async () => {
    const contentLength = 129 * 1024 * 1024;
    fetchMock.mockResolvedValueOnce(
      new Response("{}", { status: 200, headers: { "content-length": String(contentLength) } })
    );

    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      fetch: fetchMock as typeof fetch
    });
    await expect(generateText({ model: provider("gemini-3.5-flash"), prompt: "hello" })).rejects.toMatchObject({
      name: "ProviderResponseTooLargeError",
      maxBytes: 128 * 1024 * 1024,
      contentLength
    });
  });

  it("truncates Vertex error response bodies", async () => {
    fetchMock.mockResolvedValueOnce(new Response("x".repeat(100_000), { status: 500 }));

    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      fetch: fetchMock as typeof fetch
    });
    const request = generateText({ model: provider("gemini-3.5-flash"), prompt: "hello" });
    await expect(request).rejects.toMatchObject({
      name: "ProviderHTTPError",
      status: 500,
      responseBody: expect.stringContaining("truncated")
    });
  });

  it("keeps rawFetch unauthenticated for arbitrary destinations", async () => {
    fetchMock.mockResolvedValueOnce(new Response("ok"));
    const provider = createVertex({
      accessToken: "vertex-secret",
      projectId: "demo-project",
      fetch: fetchMock as typeof fetch
    });

    await provider.rawFetch("https://attacker.invalid/collect");

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://attacker.invalid/collect");
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization")).toBeNull();
  });

  it("authenticates Vertex requests with an API key", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: "api key ok" }] } }]
      })
    );

    const provider = createVertex({
      apiKey: "vertex-api-key",
      fetch: fetchMock as typeof fetch
    });

    await generateText({
      model: provider("gemini-2.0-flash"),
      prompt: "hello"
    });

    const requestURL = String(fetchMock.mock.calls[0]?.[0]);
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(requestInit.headers);
    expect(requestURL).toBe("https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.0-flash:generateContent?key=vertex-api-key");
    expect(headers.get("authorization")).toBeNull();
  });

  it("uses GOOGLE_API_KEY and VERTEX_API_KEY from the environment", async () => {
    await withVertexEnv({ GOOGLE_API_KEY: "google-env-key" }, async () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          candidates: [{ finishReason: "STOP", content: { parts: [{ text: "google env ok" }] } }]
        })
      );

      await generateText({
        model: createVertex({ fetch: fetchMock as typeof fetch })("gemini-2.0-flash"),
        prompt: "hello"
      });

      expect(String(fetchMock.mock.calls[0]?.[0])).toContain("key=google-env-key");
    });

    fetchMock.mockReset();

    await withVertexEnv({ VERTEX_API_KEY: "vertex-env-key" }, async () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          candidates: [{ finishReason: "STOP", content: { parts: [{ text: "vertex env ok" }] } }]
        })
      );

      await generateText({
        model: createVertex({ fetch: fetchMock as typeof fetch })("gemini-2.0-flash"),
        prompt: "hello"
      });

      expect(String(fetchMock.mock.calls[0]?.[0])).toContain("key=vertex-env-key");
    });
  });

  it("keeps access token auth for Vertex bearer credentials", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: "token ok" }] } }]
      })
    );

    const provider = createVertex({
      accessToken: "token",
      projectId: "demo-project",
      location: "us-central1",
      fetch: fetchMock as typeof fetch
    });

    await generateText({
      model: provider("gemini-2.0-flash"),
      prompt: "hello"
    });

    const requestURL = String(fetchMock.mock.calls[0]?.[0]);
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(requestInit.headers);
    expect(requestURL).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/demo-project/locations/us-central1/publishers/google/models/gemini-2.0-flash:generateContent"
    );
    expect(headers.get("authorization")).toBe("Bearer token");
  });

  it("defaults bearer requests to the current global v1 endpoint", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: "global ok" }] } }]
      })
    );

    const provider = createVertex({
      accessToken: "token",
      projectId: "demo-project",
      fetch: fetchMock as typeof fetch
    });

    await generateText({
      model: provider("gemini-3.5-flash"),
      prompt: "hello"
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://aiplatform.googleapis.com/v1/projects/demo-project/locations/global/publishers/google/models/gemini-3.5-flash:generateContent"
    );
  });

  it("routes Veo models from the global Vertex endpoint to us-central1", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        name: "operations/veo-global-1",
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [{ video: { uri: "gs://demo/video.mp4", mimeType: "video/mp4" } }]
          }
        }
      })
    );

    const provider = createVertex({
      accessToken: "token",
      projectId: "demo-project",
      location: "global",
      fetch: fetchMock as typeof fetch
    });
    await generateVideo({
      model: provider.videoGenerationModel!("veo-3.1-lite-generate-001"),
      prompt: "hello"
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/demo-project/locations/us-central1/publishers/google/models/veo-3.1-lite-generate-001:predictLongRunning"
    );
  });

  it("keeps regional v1beta1 endpoints available through explicit options", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: "legacy endpoint ok" }] } }]
      })
    );

    const provider = createVertex({
      accessToken: "token",
      projectId: "demo-project",
      location: "us-central1",
      apiVersion: "v1beta1",
      fetch: fetchMock as typeof fetch
    });

    await generateText({
      model: provider("gemini-2.0-flash"),
      prompt: "hello"
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1beta1/projects/demo-project/locations/us-central1/publishers/google/models/gemini-2.0-flash:generateContent"
    );
  });

  it("resolves getAccessToken lazily and supports async tokens", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: "lazy token ok" }] } }]
      })
    );
    const getAccessToken = vi.fn(async () => "lazy-token");

    const provider = createVertex({
      getAccessToken,
      projectId: "demo-project",
      location: "us-central1",
      fetch: fetchMock as typeof fetch
    });

    expect(getAccessToken).not.toHaveBeenCalled();

    await generateText({
      model: provider("gemini-2.0-flash"),
      prompt: "hello"
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(getAccessToken).toHaveBeenCalledOnce();
    expect(new Headers(requestInit.headers).get("authorization")).toBe("Bearer lazy-token");
  });

  it("prefers explicit API keys over environment access tokens", async () => {
    await withVertexEnv({ VERTEX_ACCESS_TOKEN: "env-token", GOOGLE_CLOUD_PROJECT: "env-project" }, async () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          candidates: [{ finishReason: "STOP", content: { parts: [{ text: "explicit api key ok" }] } }]
        })
      );

      await generateText({
        model: createVertex({ apiKey: "explicit-key", fetch: fetchMock as typeof fetch })("gemini-2.0-flash"),
        prompt: "hello"
      });

      const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain("key=explicit-key");
      expect(new Headers(requestInit.headers).get("authorization")).toBeNull();
    });
  });

  it("falls back to Application Default Credentials when no explicit credentials are configured", async () => {
    await withVertexEnv({ GOOGLE_CLOUD_PROJECT: "adc-project" }, async () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          candidates: [{ finishReason: "STOP", content: { parts: [{ text: "adc ok" }] } }]
        })
      );

      const provider = createVertex({
        location: "us-central1",
        fetch: fetchMock as typeof fetch
      });

      expect(googleAuthMockState.instances).toHaveLength(1);
      expect(googleAuthMockState.instances[0]?.options).toEqual({
        scopes: ["https://www.googleapis.com/auth/cloud-platform"]
      });

      await generateText({
        model: provider("gemini-2.0-flash"),
        prompt: "hello"
      });

      const requestURL = String(fetchMock.mock.calls[0]?.[0]);
      const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(requestURL).toBe(
        "https://us-central1-aiplatform.googleapis.com/v1/projects/adc-project/locations/us-central1/publishers/google/models/gemini-2.0-flash:generateContent"
      );
      expect(new Headers(requestInit.headers).get("authorization")).toBe("Bearer adc-token");
      expect(googleAuthMockState.instances[0]?.getAccessToken).toHaveBeenCalledOnce();
    });
  });

  it("passes custom scopes to Application Default Credentials", async () => {
    await withVertexEnv({ GOOGLE_CLOUD_PROJECT: "adc-project" }, async () => {
      createVertex({
        scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/devstorage.read_only"],
        fetch: fetchMock as typeof fetch
      });

      expect(googleAuthMockState.instances[0]?.options).toEqual({
        scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/devstorage.read_only"]
      });
    });
  });

  it("prefers authClient over environment API keys", async () => {
    await withVertexEnv({ GOOGLE_API_KEY: "env-api-key" }, async () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          candidates: [{ finishReason: "STOP", content: { parts: [{ text: "auth client ok" }] } }]
        })
      );
      const authClient = {
        getAccessToken: vi.fn(async () => "auth-client-token")
      };

      await generateText({
        model: createVertex({
          authClient,
          projectId: "demo-project",
          location: "us-central1",
          fetch: fetchMock as typeof fetch
        })("gemini-2.0-flash"),
        prompt: "hello"
      });

      const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("key=env-api-key");
      expect(new Headers(requestInit.headers).get("authorization")).toBe("Bearer auth-client-token");
      expect(authClient.getAccessToken).toHaveBeenCalledOnce();
    });
  });

  it("fails clearly when ADC returns no access token", async () => {
    await withVertexEnv({ GOOGLE_CLOUD_PROJECT: "adc-project" }, async () => {
      googleAuthMockState.nextToken = null;

      await expect(
        generateText({
          model: createVertex({ fetch: fetchMock as typeof fetch })("gemini-2.0-flash"),
          prompt: "hello"
        })
      ).rejects.toThrow("Missing Vertex access token.");
    });
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

  it("maps audio input to Vertex inlineData", async () => {
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

    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      fetch: fetchMock as typeof fetch
    });
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
        contents: [{ role: "user", parts: [{ text: "override" }] }],
        generationConfig: { responseMimeType: "text/plain" },
        topP: 0.95,
        candidateCount: 1
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      contents: Array<{ parts: Array<{ text: string }> }>;
      generationConfig: { responseMimeType?: string };
      topP: number;
      candidateCount: number;
    };
    expect(body.topP).toBe(0.95);
    expect(body.candidateCount).toBe(1);
    expect(body.contents[0]?.parts[0]?.text).toBe("hello");
    expect(body.generationConfig.responseMimeType).not.toBe("text/plain");
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

    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      fetch: fetchMock as typeof fetch
    });
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
      }
    });

    const secondRequestInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const body = JSON.parse(String(secondRequestInit.body)) as {
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    };

    expect(result.text).toBe("5");
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

  it("preserves Gemini thought signatures across streamed tool loops", async () => {
    const firstBody = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"call-stream-1","name":"sum","args":{"a":4,"b":6}},"thoughtSignature":"signature-stream-1"}]},"finishReason":"STOP"}]}\n\n'
          )
        );
        controller.close();
      }
    });
    const secondBody = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"candidates":[{"content":{"parts":[{"text":"10"}]},"finishReason":"STOP"}]}\n\n'
          )
        );
        controller.close();
      }
    });
    fetchMock.mockResolvedValueOnce(
      new Response(firstBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(secondBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      })
    );

    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      fetch: fetchMock as typeof fetch
    });
    const result = await streamText({
      model: provider("gemini-3.5-flash"),
      prompt: "add numbers",
      maxSteps: 2,
      tools: {
        sum: tool({
          name: "sum",
          schema: z.object({ a: z.number(), b: z.number() }),
          execute: ({ a, b }) => ({ total: a + b })
        })
      }
    }).collect();

    const secondRequestInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const body = JSON.parse(String(secondRequestInit.body)) as {
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    };
    expect(result.text).toBe("10");
    expect(body.contents[1]?.parts[0]).toMatchObject({
      functionCall: {
        id: "call-stream-1",
        name: "sum",
        args: { a: 4, b: 6 }
      },
      thoughtSignature: "signature-stream-1"
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

  it("maps Google Maps grounding and coordinates to the Vertex request schema", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Nearby places" }] } }]
      })
    );

    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      fetch: fetchMock as typeof fetch
    });
    await generateText({
      model: provider("gemini-3.5-flash"),
      prompt: "Where can I get espresso nearby?",
      tools: {
        maps: googleMapsTool({
          latitude: 40.7128,
          longitude: -74.006,
          enableWidget: true
        })
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      tools: Array<Record<string, unknown>>;
      toolConfig: Record<string, unknown>;
    };
    expect(body.tools).toEqual([{ googleMaps: { enableWidget: true } }]);
    expect(body.toolConfig).toEqual({
      retrievalConfig: {
        latLng: {
          latitude: 40.7128,
          longitude: -74.006
        }
      }
    });
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
      "https://us-central1-aiplatform.googleapis.com/v1/projects/demo-project/locations/us-central1/cachedContents"
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

  it("rejects legacy reasoning budget tokens for Vertex Gemini 3 models", async () => {
    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      location: "us-central1",
      fetch: fetchMock as typeof fetch
    });

    await expect(
      generateText({
        model: provider("gemini-3.5-flash"),
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

  it("streams Gemini 3.1 speech through Vertex", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        [
          'data: {"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"audio/pcm","data":"AQI="}}]}}]}',
          "",
          'data: {"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"audio/pcm","data":"AwQ="}}]}}]}',
          ""
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } }
      )
    );

    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      fetch: fetchMock as typeof fetch
    });
    const chunks = [];
    for await (const chunk of await streamSpeech({
      model: provider.speechModel!("gemini-3.1-flash-tts-preview"),
      input: "hello there"
    })) {
      chunks.push(Array.from(chunk.audio));
    }

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/models/gemini-3.1-flash-tts-preview:streamGenerateContent?alt=sse"
    );
    expect(chunks).toEqual([
      [1, 2],
      [3, 4]
    ]);
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
    expect(JSON.stringify(result.rawResponse)).not.toContain("AQID");
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
    expect(JSON.stringify(result.images[0]?.providerMetadata)).not.toContain("BAUG");
    expect(JSON.stringify(result.rawResponse)).not.toContain("BAUG");
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
    expect(JSON.stringify(result.audio[0]?.providerMetadata)).not.toContain("BwgJ");
    expect(JSON.stringify(result.rawResponse)).not.toContain("BwgJ");
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

  it("defaults Vertex Live sessions to the global v1 LlmBidiService endpoint", async () => {
    const connectionFactory = vi.fn(async (url: string) => {
      expect(url).toBe(
        "wss://aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent"
      );
      return {
        async sendJson() {},
        async recvJson() {
          return undefined;
        },
        async close() {}
      };
    });
    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      fetch: fetchMock as typeof fetch,
      realtimeConnectionFactory: connectionFactory
    });

    const session = await provider.realtimeModel!("gemini-live-2.5-flash-native-audio").connect();
    await session.close();

    expect(connectionFactory).toHaveBeenCalledOnce();
  });

  it("preserves the explicit Vertex Live endpoint override", async () => {
    const connectionFactory = vi.fn(async (url: string) => {
      expect(url).toBe("wss://vertex-proxy.example.test/live");
      return {
        async sendJson() {},
        async recvJson() {
          return undefined;
        },
        async close() {}
      };
    });
    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      realtimeURL: "wss://vertex-proxy.example.test/live",
      fetch: fetchMock as typeof fetch,
      realtimeConnectionFactory: connectionFactory
    });

    const session = await provider.realtimeModel!("gemini-live-2.5-flash-native-audio").connect();
    await session.close();

    expect(connectionFactory).toHaveBeenCalledOnce();
  });

  it("connects Vertex Live sessions using the documented BidiGenerateContent websocket", async () => {
    const sent: Record<string, unknown>[] = [];
    const connectionFactory = vi.fn(async (url: string, headers: Record<string, string>) => {
      expect(url).toBe(
        "wss://us-central1-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1alpha.LlmBidiService/BidiGenerateContent"
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
      apiVersion: "v1alpha",
      fetch: fetchMock as typeof fetch,
      realtimeConnectionFactory: connectionFactory
    });
    const session = await provider.realtimeModel!("gemini-live-2.5-flash-native-audio").connect({
      instructions: "Be brief.",
      reasoning: { budgetTokens: 256, includeThoughts: true },
      inputAudioTranscription: true,
      outputAudioTranscription: true,
      mediaResolution: "MEDIA_RESOLUTION_LOW",
      affectiveDialog: true,
      proactiveAudio: true
    });

    await session.sendMedia({ data: "vertex-image", mediaType: "image/jpeg" });
    await session.sendText("hello vertex");
    await session.close();

    expect(connectionFactory).toHaveBeenCalledOnce();
    expect(sent[0]).toMatchObject({
      setup: expect.objectContaining({
        model: "models/gemini-live-2.5-flash-native-audio",
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        mediaResolution: "MEDIA_RESOLUTION_LOW",
        enableAffectiveDialog: true,
        proactivity: { proactiveAudio: true },
        generationConfig: expect.objectContaining({
          thinkingConfig: { thinkingBudget: 256, includeThoughts: true }
        })
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

  it("connects Vertex Gemini 3.5 Live Translate sessions with typed translation config", async () => {
    const sent: Record<string, unknown>[] = [];
    const connectionFactory = vi.fn(async (url: string, headers: Record<string, string>) => {
      expect(url).toBe(
        "wss://us-central1-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1alpha.LlmBidiService/BidiGenerateContent"
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
      apiVersion: "v1alpha",
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
      providerOptions: {
        translationConfig: {
          echoTargetLanguage: true
        }
      }
    });

    await session.sendAudio({ data: "vertex-audio", mediaType: "audio/pcm" });
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
    expect(sent[1]).toMatchObject({
      realtimeInput: {
        audio: {
          mimeType: "audio/pcm",
          data: "vertex-audio"
        }
      }
    });
  });

  it("rejects unsupported Vertex Gemini 3.5 Live Translate setup and inputs", async () => {
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
    const provider = createVertex({
      accessToken: "test",
      projectId: "demo-project",
      location: "us-central1",
      apiVersion: "v1alpha",
      fetch: fetchMock as typeof fetch,
      realtimeConnectionFactory: connectionFactory
    });

    await expect(provider.realtimeModel!("gemini-3.5-live-translate-preview").connect()).rejects.toThrow(
      'Model "vertex/gemini-3.5-live-translate-preview" requires "translation.targetLanguage".'
    );
    await expect(
      provider.realtimeModel!("gemini-3.5-live-translate-preview").connect({
        translation: { targetLanguage: "pl" },
        instructions: "Translate politely."
      })
    ).rejects.toThrow('Model "vertex/gemini-3.5-live-translate-preview" does not support realtime system instructions.');
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
    ).rejects.toThrow('Model "vertex/gemini-3.5-live-translate-preview" does not support realtime tools.');

    const session = await provider.realtimeModel!("gemini-3.5-live-translate-preview").connect({
      translation: { targetLanguage: "pl" }
    });

    await expect(session.sendText("hello")).rejects.toThrow(
      'Model "vertex/gemini-3.5-live-translate-preview" only supports audio input.'
    );
    await expect(session.sendMedia({ data: "image", mediaType: "image/jpeg" })).rejects.toThrow(
      'Model "vertex/gemini-3.5-live-translate-preview" only supports audio input.'
    );
    expect(sent).toHaveLength(1);
    await session.close();
  });

  it("rejects Vertex Live sessions when only API key auth is configured", async () => {
    const provider = createVertex({
      apiKey: "vertex-api-key",
      fetch: fetchMock as typeof fetch
    });

    await expect(provider.realtimeModel!("gemini-live-2.5-flash-native-audio").connect()).rejects.toThrow(
      'Provider "vertex" realtime sessions require accessToken or getAccessToken auth.'
    );
  });

  it("connects Vertex Live sessions with authClient bearer tokens", async () => {
    const connectionFactory = vi.fn(async (_url: string, headers: Record<string, string>) => {
      expect(headers).toMatchObject({
        authorization: "Bearer auth-client-token"
      });
      return {
        async sendJson() {},
        async recvJson() {
          return undefined;
        },
        async close() {}
      };
    });
    const authClient = {
      getAccessToken: vi.fn(async () => "auth-client-token")
    };

    const provider = createVertex({
      authClient,
      projectId: "demo-project",
      location: "us-central1",
      fetch: fetchMock as typeof fetch,
      realtimeConnectionFactory: connectionFactory
    });

    const session = await provider.realtimeModel!("gemini-live-2.5-flash-native-audio").connect();
    await session.close();

    expect(authClient.getAccessToken).toHaveBeenCalledOnce();
    expect(connectionFactory).toHaveBeenCalledOnce();
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
