import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { embedMany, generateGroundedText, generateObject, generateSpeech, generateText, hostedTool, tool, transcribeAudio } from "@zhivex-ai/core";
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
    expectedCapabilities: {
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
      embeddings: true,
      reasoning: true,
      webSearch: true
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
});
