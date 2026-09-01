import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { generateObject, generateText, getAgentCapabilities, providerDataPart, streamText, tool } from "@zhivex-ai/core";
import { runAgentProviderContractSuite } from "../../core/tests/agent-provider-contract.js";
import { runLanguageModelContractSuite } from "../../core/tests/provider-contract.js";
import { anthropicCodeExecutionTool, anthropicMcpToolset, anthropicWebSearchTool, createAnthropic } from "../src/index.js";

const withEnvironment = async <T>(
  values: Record<string, string | undefined>,
  operation: () => Promise<T>
): Promise<T> => {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    return await operation();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
};

describe("anthropic adapter", () => {
  const fetchMock = vi.fn();

  runLanguageModelContractSuite({
    providerName: "anthropic",
    modelId: "claude-3-5-sonnet",
    createModel: () => createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch })("claude-3-5-sonnet"),
    expectedAgentTier: "tier-b",
    expectedCapabilities: {
      streaming: true,
      tools: true,
      structuredOutput: false,
      jsonMode: false,
      toolChoice: true,
      parallelToolCalls: true,
      vision: true,
      files: true,
      audioInput: false,
      audioOutput: false,
      embeddings: false,
      reasoning: true,
      webSearch: true
    }
  });

  runAgentProviderContractSuite({
    providerName: "anthropic",
    modelId: "claude-3-5-sonnet",
    expectedAgentTier: "tier-b",
    createModel: () => createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch })("claude-3-5-sonnet"),
    mockSimpleRun: () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          content: [{ type: "text", text: "hello from anthropic agent" }],
          stop_reason: "end_turn"
        })
      );
    },
    mockToolRun: () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          content: [{ type: "tool_use", id: "tool-1", name: "weather", input: { city: "Madrid" } }],
          stop_reason: "tool_use"
        })
      );
      fetchMock.mockResolvedValueOnce(
        Response.json({
          content: [{ type: "text", text: "Madrid is sunny" }],
          stop_reason: "end_turn"
        })
      );
    },
    mockStreamRun: () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              "event: content_block_delta\n" +
                'data: {"index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n' +
                "event: content_block_delta\n" +
                'data: {"index":0,"delta":{"type":"text_delta","text":" world"}}\n\n' +
                "event: message_stop\n" +
                'data: {"stop_reason":"end_turn"}\n\n'
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

  it("maps message responses into common text output", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("claude-3-5-sonnet"),
      prompt: "hello"
    });

    expect(result.text).toBe("hello from anthropic");
    expect(result.finishReason).toBe("stop");
  });

  it("reads ANTHROPIC_AUTH_TOKEN and sends bearer authentication", async () => {
    await withEnvironment(
      {
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: "sentinel-anthropic-auth-token"
      },
      async () => {
        fetchMock.mockResolvedValueOnce(
          Response.json({
            content: [{ type: "text", text: "bearer authenticated" }],
            stop_reason: "end_turn"
          })
        );

        const provider = createAnthropic({ fetch: fetchMock as typeof fetch });
        await generateText({ model: provider("claude-3-5-sonnet"), prompt: "hello" });

        const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
        expect(headers.get("authorization")).toBe("Bearer sentinel-anthropic-auth-token");
        expect(headers.has("x-api-key")).toBe(false);
      }
    );
  });

  it("lets explicit bearer authentication override an ambient API key", async () => {
    await withEnvironment({ ANTHROPIC_API_KEY: "ambient-api-key" }, async () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({ content: [{ type: "text", text: "explicit bearer" }], stop_reason: "end_turn" })
      );

      const provider = createAnthropic({
        authToken: "explicit-auth-token",
        fetch: fetchMock as typeof fetch
      });
      await generateText({ model: provider("claude-3-5-sonnet"), prompt: "hello" });

      const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
      expect(headers.get("authorization")).toBe("Bearer explicit-auth-token");
      expect(headers.has("x-api-key")).toBe(false);
    });
  });

  it("rejects multiple explicit credential-chain sources", () => {
    expect(() =>
      createAnthropic({
        credentials: async () => ({
          token: "access-token",
          expiresAt: null
        }),
        config: {
          authentication: {
            type: "user_oauth"
          }
        },
        fetch: fetchMock as typeof fetch
      })
    ).toThrow('Pass at most one of "profile", "credentials", or "config"');
  });

  it("prefers an API key and sends the selected workspace for multi-workspace keys", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "workspace authenticated" }],
        stop_reason: "end_turn"
      })
    );

    const provider = createAnthropic({
      apiKey: "sentinel-api-key",
      authToken: "sentinel-auth-token",
      workspaceId: "wrkspc_test",
      fetch: fetchMock as typeof fetch
    });
    await generateText({ model: provider("claude-3-5-sonnet"), prompt: "hello" });

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-api-key")).toBe("sentinel-api-key");
    expect(headers.get("anthropic-workspace-id")).toBe("wrkspc_test");
    expect(headers.has("authorization")).toBe(false);
  });

  it("resolves async API keys before every request", async () => {
    const apiKey = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("rotated-key-1")
      .mockResolvedValueOnce("rotated-key-2");
    fetchMock
      .mockResolvedValueOnce(Response.json({ content: [{ type: "text", text: "first" }], stop_reason: "end_turn" }))
      .mockResolvedValueOnce(Response.json({ content: [{ type: "text", text: "second" }], stop_reason: "end_turn" }));

    const provider = createAnthropic({ apiKey, fetch: fetchMock as typeof fetch });
    await generateText({ model: provider("claude-3-5-sonnet"), prompt: "first" });
    await generateText({ model: provider("claude-3-5-sonnet"), prompt: "second" });

    expect(apiKey).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("x-api-key")).toBe("rotated-key-1");
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("x-api-key")).toBe("rotated-key-2");
  });

  it("refreshes access-token credentials once after a 401", async () => {
    const credentials = vi.fn(async (options?: { forceRefresh?: boolean }) => ({
      token: options?.forceRefresh ? "fresh-access-token" : "stale-access-token",
      expiresAt: Math.floor(Date.now() / 1000) + 3_600
    }));
    fetchMock
      .mockResolvedValueOnce(Response.json({ error: { type: "authentication_error" } }, { status: 401 }))
      .mockResolvedValueOnce(
        Response.json({ content: [{ type: "text", text: "refreshed" }], stop_reason: "end_turn" })
      );

    const provider = createAnthropic({
      apiKey: null,
      authToken: null,
      credentials,
      fetch: fetchMock as typeof fetch
    });
    const result = await generateText({ model: provider("claude-3-5-sonnet"), prompt: "hello" });

    expect(result.text).toBe("refreshed");
    expect(credentials).toHaveBeenNthCalledWith(1, undefined);
    expect(credentials).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer stale-access-token"
    );
    const refreshedHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(refreshedHeaders.get("authorization")).toBe("Bearer fresh-access-token");
    expect(refreshedHeaders.get("anthropic-beta")?.split(",")).toContain("oauth-2025-04-20");
  });

  it("resolves Workload Identity Federation from the Anthropic environment", async () => {
    await withEnvironment(
      {
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
        ANTHROPIC_PROFILE: undefined,
        ANTHROPIC_CONFIG_DIR: "/tmp/zhivex-anthropic-auth-test-no-profile",
        ANTHROPIC_FEDERATION_RULE_ID: "fdrl_test",
        ANTHROPIC_ORGANIZATION_ID: "00000000-0000-0000-0000-000000000000",
        ANTHROPIC_SERVICE_ACCOUNT_ID: "svac_test",
        ANTHROPIC_WORKSPACE_ID: "wrkspc_test",
        ANTHROPIC_IDENTITY_TOKEN_FILE: undefined,
        ANTHROPIC_IDENTITY_TOKEN: "sentinel-identity-token"
      },
      async () => {
        fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input) === "https://api.anthropic.com/v1/oauth/token") {
            const headers = new Headers(init?.headers);
            expect(headers.get("anthropic-beta")?.split(",")).toEqual(
              expect.arrayContaining(["oauth-2025-04-20", "oidc-federation-2026-04-01"])
            );
            expect(JSON.parse(String(init?.body))).toMatchObject({
              assertion: "sentinel-identity-token",
              federation_rule_id: "fdrl_test",
              organization_id: "00000000-0000-0000-0000-000000000000",
              service_account_id: "svac_test",
              workspace_id: "wrkspc_test"
            });
            return Response.json({
              access_token: "federated-access-token",
              token_type: "Bearer",
              expires_in: 3_600
            });
          }

          expect(String(input)).toBe("https://api.anthropic.com/v1/messages");
          const headers = new Headers(init?.headers);
          expect(headers.get("authorization")).toBe("Bearer federated-access-token");
          expect(headers.has("anthropic-workspace-id")).toBe(false);
          return Response.json({ content: [{ type: "text", text: "federated" }], stop_reason: "end_turn" });
        });

        const provider = createAnthropic({
          apiKey: null,
          authToken: null,
          fetch: fetchMock as typeof fetch
        });
        const result = await generateText({ model: provider("claude-3-5-sonnet"), prompt: "hello" });

        expect(result.text).toBe("federated");
        expect(fetchMock).toHaveBeenCalledTimes(2);
      }
    );
  });

  it("fails on first use when the complete credential chain is empty", async () => {
    await withEnvironment(
      {
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
        ANTHROPIC_PROFILE: undefined,
        ANTHROPIC_CONFIG_DIR: "/tmp/zhivex-anthropic-auth-test-empty-chain",
        ANTHROPIC_FEDERATION_RULE_ID: undefined,
        ANTHROPIC_ORGANIZATION_ID: undefined,
        ANTHROPIC_SERVICE_ACCOUNT_ID: undefined,
        ANTHROPIC_WORKSPACE_ID: undefined,
        ANTHROPIC_IDENTITY_TOKEN_FILE: undefined,
        ANTHROPIC_IDENTITY_TOKEN: undefined
      },
      async () => {
        const provider = createAnthropic({ fetch: fetchMock as typeof fetch });
        await expect(
          generateText({ model: provider("claude-3-5-sonnet"), prompt: "hello" })
        ).rejects.toThrow("Could not resolve Anthropic credentials");
        expect(fetchMock).not.toHaveBeenCalled();
      }
    );
  });

  it.each([307, 308])("rejects authenticated %i redirects before contacting the destination", async (status) => {
    let destinationRequests = 0;
    const redirectingFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input) === "https://attacker.example/collect") {
        destinationRequests += 1;
        return Response.json({
          content: [{ type: "text", text: "unexpected" }],
          stop_reason: "end_turn"
        });
      }

      const redirect = new Response(null, {
        status,
        headers: { location: "https://attacker.example/collect" }
      });
      if (init?.redirect === "error") {
        throw new TypeError("Redirects are rejected for authenticated requests.");
      }
      return redirectingFetch(redirect.headers.get("location")!, init);
    });
    const provider = createAnthropic({
      apiKey: "sentinel-anthropic-key",
      fetch: redirectingFetch as typeof fetch
    });

    await expect(generateText({
      model: provider("claude-3-5-sonnet"),
      prompt: "sensitive prompt"
    })).rejects.toThrow("Redirects are rejected");

    expect(destinationRequests).toBe(0);
    expect(redirectingFetch).toHaveBeenCalledTimes(1);
    expect(redirectingFetch.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: expect.objectContaining({ "x-api-key": "sentinel-anthropic-key" })
    });
  });

  it("creates equivalent language models from the callable provider", () => {
    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });

    expect(provider("claude-3-5-sonnet")).toMatchObject(provider.languageModel("claude-3-5-sonnet"));
  });

  it("supports tool calls", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "tool_use", id: "tool-1", name: "math", input: { value: 2 } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      })
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "result is 4" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("claude-3-5-sonnet"),
      prompt: "double 2",
      maxSteps: 2,
      tools: {
        math: tool({
          name: "math",
          schema: z.object({ value: z.number() }),
          execute: ({ value }) => ({ result: value * 2 })
        })
      }
    });

    expect(result.text).toBe("result is 4");
    expect(result.toolResults[0]?.toolName).toBe("math");
    expect(provider.embeddingModel).toBeUndefined();
  });

  it("falls back to prompted structured output", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: JSON.stringify({ title: "Soup" }) }],
        stop_reason: "end_turn",
        usage: { input_tokens: 4, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateObject({
      model: provider("claude-3-5-sonnet"),
      prompt: "Return JSON",
      schema: z.object({
        title: z.string()
      })
    });

    expect(result.object.title).toBe("Soup");
    expect(result.objectMode).toBe("prompted");
  });

  it("passes provider-specific options through to the Anthropic API", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-3-5-sonnet"),
      prompt: "hello",
      providerOptions: {
        top_p: 0.9,
        metadata: { source: "test" }
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { top_p: number; metadata: { source: string } };
    expect(body.top_p).toBe(0.9);
    expect(body.metadata.source).toBe("test");
  });

  it("maps common tool choice to Anthropic tool_choice", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-3-5-sonnet"),
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
      tool_choice: { type: string; name: string };
    };
    expect(body.tool_choice).toEqual({
      type: "tool",
      name: "weather"
    });
  });

  it("maps toolChoice none to Anthropic tool_choice", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-3-5-sonnet"),
      prompt: "hello",
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city })
        })
      },
      toolChoice: "none"
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      tool_choice: { type: string };
    };
    expect(body.tool_choice).toEqual({
      type: "none"
    });
  });

  it("maps hosted Anthropic web search tools into native tool definitions", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-3-5-sonnet"),
      prompt: "hello",
      tools: {
        web: anthropicWebSearchTool({
          max_uses: 3
        })
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      tools: Array<{ type: string; name: string; max_uses: number }>;
    };
    expect(body.tools).toEqual([
      {
        type: "web_search_20260209",
        name: "web_search",
        max_uses: 3
      }
    ]);
    expect(getAgentCapabilities(provider("claude-3-5-sonnet")).codeExecution).toBe(true);
  });

  it("maps Anthropic code execution into the current generally available tool", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [
          { type: "server_tool_use", id: "srv_1", name: "bash_code_execution", input: { command: "python -V" } },
          {
            type: "bash_code_execution_tool_result",
            tool_use_id: "srv_1",
            content: { type: "bash_code_execution_result", stdout: "Python 3.11", stderr: "", return_code: 0 }
          },
          { type: "text", text: "done" }
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("claude-sonnet-4"),
      prompt: "run code",
      tools: {
        code: anthropicCodeExecutionTool()
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = requestInit.headers as Record<string, string>;
    const body = JSON.parse(String(requestInit.body)) as { tools: Array<{ type: string; name: string }> };
    expect(headers["anthropic-beta"]).toBeUndefined();
    expect(body.tools).toEqual([{ type: "code_execution_20260521", name: "code_execution" }]);
    expect(result.messages.at(-1)?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "provider-data",
          provider: "anthropic",
          data: expect.objectContaining({ type: "server_tool_use" })
        }),
        expect.objectContaining({
          type: "provider-data",
          provider: "anthropic",
          data: expect.objectContaining({ type: "bash_code_execution_tool_result" })
        })
      ])
    );
  });

  it("maps reasoning budget tokens to Anthropic thinking", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-3-5-sonnet"),
      prompt: "hello",
      reasoning: {
        budgetTokens: 1024
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = requestInit.headers as Record<string, string>;
    const body = JSON.parse(String(requestInit.body)) as {
      thinking: { type: string; budget_tokens: number };
    };
    expect(body.thinking).toEqual({
      type: "enabled",
      budget_tokens: 1024
    });
  });

  it("maps reasoning effort to adaptive thinking and output_config for Claude Opus 4.7", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-opus-4-7"),
      prompt: "hello",
      reasoning: {
        effort: "high"
      },
      providerOptions: {
        thinking: {
          type: "adaptive",
          display: "summarized"
        },
        output_config: {
          task_budget: {
            type: "tokens",
            total: 24000
          }
        }
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      thinking: { type: string; display?: string };
      output_config: { effort: string; task_budget: { type: string; total: number } };
    };
    expect(body.thinking).toEqual({
      type: "adaptive",
      display: "summarized"
    });
    expect(body.output_config).toEqual({
      effort: "high",
      task_budget: {
        type: "tokens",
        total: 24000
      }
    });
  });

  it("keeps manual thinking plus effort for Claude Opus 4.5", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-opus-4-5"),
      prompt: "hello",
      reasoning: {
        budgetTokens: 1024,
        effort: "medium"
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      thinking: { type: string; budget_tokens: number };
      output_config: { effort: string };
    };
    expect(body.thinking).toEqual({
      type: "enabled",
      budget_tokens: 1024
    });
    expect(body.output_config).toEqual({
      effort: "medium"
    });
  });

  it("maps Claude Haiku 4.5 extended thinking through budget tokens", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from haiku 4.5" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 8, output_tokens: 3 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-haiku-4-5-20251001"),
      prompt: "hello",
      reasoning: {
        budgetTokens: 4096
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      model: string;
      thinking: { type: string; budget_tokens: number };
      output_config?: unknown;
    };
    expect(body).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      thinking: {
        type: "enabled",
        budget_tokens: 4096
      }
    });
    expect(body.output_config).toBeUndefined();
  });

  it("sends adaptive thinking config on streaming requests for Claude Opus 4.7", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "event: content_block_delta\n" +
              'data: {"index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n' +
              "event: message_stop\n" +
              'data: {"stop_reason":"end_turn"}\n\n'
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

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("claude-opus-4-7"),
      prompt: "hello",
      reasoning: {
        effort: "high"
      }
    });

    await result.collect();

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const requestBody = JSON.parse(String(requestInit.body)) as {
      thinking: { type: string };
      output_config: { effort: string };
    };
    expect(requestBody.thinking).toEqual({
      type: "adaptive"
    });
    expect(requestBody.output_config).toEqual({
      effort: "high"
    });
  });

  it("sends Claude Opus 4.8 fast mode and maps usage speed", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from opus 4.8" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4, speed: "fast" }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("claude-opus-4-8"),
      prompt: "hello",
      reasoning: {
        effort: "xhigh"
      },
      providerOptions: {
        speed: "fast"
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = requestInit.headers as Record<string, string>;
    const body = JSON.parse(String(requestInit.body)) as {
      model: string;
      speed: string;
      thinking: { type: string };
      output_config: { effort: string };
    };

    expect(body).toMatchObject({
      model: "claude-opus-4-8",
      speed: "fast",
      thinking: { type: "adaptive" },
      output_config: { effort: "xhigh" }
    });
    expect(headers["anthropic-beta"]?.split(",")).toContain("fast-mode-2026-02-01");
    expect(result.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      speed: "fast"
    });
  });

  it("supports Claude Opus 5 max effort, managed fallbacks, task budgets, and composed beta headers", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from opus 5" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
          output_tokens: 4,
          output_tokens_details: { thinking_tokens: 2 },
          speed: "fast"
        }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const model = provider("claude-opus-5");
    expect(model.capabilities.reasoningEfforts).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);

    const result = await generateText({
      model,
      prompt: "hello",
      maxTokens: 64_000,
      reasoning: {
        effort: "max"
      },
      providerOptions: {
        speed: "fast",
        fallbacks: "default",
        midConversationToolChanges: true,
        betas: ["custom-feature-2026-07-24", "fast-mode-2026-02-01"],
        output_config: {
          task_budget: {
            type: "tokens",
            total: 64_000,
            remaining: 48_000
          }
        }
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = requestInit.headers as Record<string, string>;
    const betas = headers["anthropic-beta"]?.split(",") ?? [];
    const body = JSON.parse(String(requestInit.body)) as Record<string, unknown>;

    expect(new Set(betas)).toEqual(
      new Set([
        "custom-feature-2026-07-24",
        "fast-mode-2026-02-01",
        "task-budgets-2026-03-13",
        "server-side-fallback-2026-07-01",
        "mid-conversation-tool-changes-2026-07-01"
      ])
    );
    expect(betas.filter((beta) => beta === "fast-mode-2026-02-01")).toHaveLength(1);
    expect(body).toMatchObject({
      model: "claude-opus-5",
      speed: "fast",
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: {
        effort: "max",
        task_budget: {
          type: "tokens",
          total: 64_000,
          remaining: 48_000
        }
      }
    });
    expect(body.betas).toBeUndefined();
    expect(body.midConversationToolChanges).toBeUndefined();
    expect(result.usage).toEqual({
      inputTokens: 15,
      cachedInputTokens: 3,
      cacheWriteTokens: 2,
      outputTokens: 4,
      reasoningTokens: 2,
      totalTokens: 19,
      speed: "fast"
    });
  });

  it("leaves Claude Opus 5 adaptive thinking at its API default and supports disabling it at high effort", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ content: [], stop_reason: "end_turn", usage: {} }))
      .mockResolvedValueOnce(Response.json({ content: [], stop_reason: "end_turn", usage: {} }));

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-opus-5"),
      prompt: "default"
    });
    await generateText({
      model: provider("claude-opus-5"),
      prompt: "disabled",
      reasoning: { effort: "high" },
      providerOptions: {
        thinking: { type: "disabled" }
      }
    });

    const defaultBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    const disabledBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(defaultBody.thinking).toBeUndefined();
    expect(defaultBody.output_config).toBeUndefined();
    expect(disabledBody).toMatchObject({
      thinking: { type: "disabled" },
      output_config: { effort: "high" }
    });
  });

  it("maps Claude Opus 5 common none and accepts only documented default sampling values", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "concise" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 2, output_tokens: 1 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-opus-5"),
      prompt: "hello",
      temperature: 1,
      reasoning: { effort: "none" },
      providerOptions: {
        top_p: 0.99
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body));
    expect(body).toMatchObject({
      temperature: 1,
      top_p: 0.99,
      thinking: { type: "disabled" }
    });
    expect(body.output_config).toBeUndefined();
  });

  it.each([
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-mythos-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-opus-4-5-20251101",
    "claude-sonnet-4-5-20250929",
    "claude-haiku-4-5-20251001",
    "claude-opus-4-1-20250805"
  ])("maps %s native structured output through output_config.format", async (modelId) => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: JSON.stringify({ city: "Buenos Aires" }) }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const model = provider(modelId);
    const result = await generateObject({
      model,
      prompt: "Return one city.",
      schema: z.object({ city: z.string() })
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body));
    expect(model.capabilities.structuredOutput).toBe(true);
    expect(result.objectMode).toBe("native");
    expect(result.object).toEqual({ city: "Buenos Aires" });
    expect(body).toMatchObject({
      model: modelId,
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              city: { type: "string" }
            },
            required: ["city"]
          }
        }
      }
    });
  });

  it("rejects invalid Claude Opus 5 thinking, sampling, task budget, and fallback combinations", async () => {
    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const model = provider("claude-opus-5");

    await expect(
      generateText({
        model,
        prompt: "hello",
        reasoning: { effort: "max" },
        providerOptions: { thinking: { type: "disabled" } }
      })
    ).rejects.toThrow(/cannot combine "thinking\.disabled".*"output_config\.effort=max"/);

    await expect(
      generateText({
        model,
        prompt: "hello",
        providerOptions: {
          thinking: { type: "disabled" },
          output_config: { effort: "xhigh" }
        }
      })
    ).rejects.toThrow(/cannot combine "thinking\.disabled".*"output_config\.effort=xhigh"/);

    await expect(
      generateText({
        model,
        prompt: "hello",
        providerOptions: {
          thinking: { type: "enabled", budget_tokens: 20_000 }
        }
      })
    ).rejects.toThrow(/does not support manual "thinking\.enabled \+ budget_tokens"/);

    await expect(generateText({ model, prompt: "hello", temperature: 0.5 })).rejects.toThrow(
      /only supports the default "temperature=1"/
    );

    await expect(
      generateText({
        model,
        prompt: "hello",
        providerOptions: {
          output_config: {
            task_budget: { type: "tokens", total: 19_999 }
          }
        }
      })
    ).rejects.toThrow(/task_budget\.total.*at least 20000/);

    await expect(
      generateText({
        model,
        prompt: "hello",
        providerOptions: {
          fallbacks: [{ model: "claude-opus-5" }]
        }
      })
    ).rejects.toThrow(/fallback models.*different from the primary model/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-mythos-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-opus-4-6"
  ])("rejects assistant prefill locally for %s", async (modelId) => {
    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider(modelId),
        messages: [
          { role: "user", parts: [{ type: "text", text: "Complete this." }] },
          { role: "assistant", parts: [{ type: "text", text: "Prefill" }] }
        ]
      })
    ).rejects.toThrow(`Provider "anthropic" does not support assistant prefill for model "${modelId}".`);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("streams Claude Opus 5 max effort and merges message-start cache usage with final output usage", async () => {
    const responseBody = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "event: message_start\n" +
              'data: {"message":{"usage":{"input_tokens":8,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}}\n\n' +
              "event: content_block_delta\n" +
              'data: {"index":0,"delta":{"type":"text_delta","text":"done"}}\n\n' +
              "event: message_delta\n" +
              'data: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5,"output_tokens_details":{"thinking_tokens":2},"speed":"standard"}}\n\n' +
              "event: message_stop\n" +
              "data: {}\n\n"
          )
        );
        controller.close();
      }
    });
    fetchMock.mockResolvedValueOnce(
      new Response(responseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("claude-opus-5"),
      prompt: "hello",
      reasoning: { effort: "max" },
      providerOptions: { speed: "fast" }
    });
    const final = await result.collect();

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = requestInit.headers as Record<string, string>;
    const body = JSON.parse(String(requestInit.body));
    expect(headers["anthropic-beta"]?.split(",")).toContain("fast-mode-2026-02-01");
    expect(body).toMatchObject({
      stream: true,
      thinking: { type: "adaptive" },
      output_config: { effort: "max" }
    });
    expect(final).toMatchObject({
      text: "done",
      usage: {
        inputTokens: 13,
        cachedInputTokens: 3,
        cacheWriteTokens: 2,
        outputTokens: 5,
        reasoningTokens: 2,
        totalTokens: 18,
        speed: "standard"
      }
    });
  });

  it("maps Claude Sonnet 5 as a modern adaptive-thinking model", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from sonnet 5" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("claude-sonnet-5"),
      prompt: "hello",
      reasoning: {
        effort: "xhigh"
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      model: string;
      thinking: { type: string };
      output_config: { effort: string };
    };

    expect(body).toMatchObject({
      model: "claude-sonnet-5",
      thinking: { type: "adaptive" },
      output_config: { effort: "xhigh" }
    });
    expect(result.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14
    });
  });

  it("maps Claude Fable 5 effort without redundant thinking config and enables server-side fallback", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from fable 5" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-fable-5"),
      prompt: "hello",
      reasoning: {
        effort: "high"
      },
      providerOptions: {
        fallbacks: [{ model: "claude-opus-4-8" }]
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = requestInit.headers as Record<string, string>;
    const body = JSON.parse(String(requestInit.body)) as {
      model: string;
      thinking?: unknown;
      output_config: { effort: string };
      fallbacks: Array<{ model: string }>;
    };

    expect(headers["anthropic-beta"]).toBe("server-side-fallback-2026-06-01");
    expect(body).toMatchObject({
      model: "claude-fable-5",
      output_config: { effort: "high" },
      fallbacks: [{ model: "claude-opus-4-8" }]
    });
    expect(body.thinking).toBeUndefined();
  });

  it("allows summarized thinking display on Claude Mythos 5", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from mythos 5" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-mythos-5"),
      prompt: "hello",
      providerOptions: {
        thinking: {
          type: "adaptive",
          display: "summarized"
        }
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      thinking: { type: string; display?: string };
    };

    expect(body.thinking).toEqual({
      type: "adaptive",
      display: "summarized"
    });
  });

  it("preserves valid mid-conversation system messages for Claude Opus 4.8", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-opus-4-8"),
      messages: [
        { role: "system", parts: [{ type: "text", text: "Initial instruction." }] },
        { role: "user", parts: [{ type: "text", text: "Start." }] },
        { role: "system", parts: [{ type: "text", text: "Apply this local instruction." }] },
        { role: "assistant", parts: [{ type: "text", text: "Ready." }] },
        { role: "user", parts: [{ type: "text", text: "Continue." }] }
      ]
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      system: string;
      messages: Array<{ role: string; content: unknown }>;
    };

    expect(body.system).toBe("Initial instruction.");
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Start." }] },
      { role: "system", content: "Apply this local instruction." },
      { role: "assistant", content: [{ type: "text", text: "Ready." }] },
      { role: "user", content: [{ type: "text", text: "Continue." }] }
    ]);
  });

  it("replays Claude Opus 5 thinking and fallback blocks without changing their order", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "continued" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const fallbackBlock = {
      type: "fallback",
      from: { model: "claude-opus-5" },
      to: { model: "claude-opus-4-8" },
      trigger: { category: "cyber" }
    } as const;
    const thinkingBlock = {
      type: "thinking",
      thinking: "summary",
      signature: "signed-thinking"
    } as const;
    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await generateText({
      model: provider("claude-opus-5"),
      messages: [
        { role: "user", parts: [{ type: "text", text: "Start." }] },
        {
          role: "assistant",
          parts: [
            providerDataPart("anthropic", fallbackBlock),
            providerDataPart("anthropic", thinkingBlock),
            { type: "text", text: "Partial answer." }
          ]
        },
        { role: "user", parts: [{ type: "text", text: "Continue." }] }
      ]
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body));
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: [fallbackBlock, thinkingBlock, { type: "text", text: "Partial answer." }]
    });
  });

  it("preserves Opus 5 mid-conversation tool-change blocks and adds only the required header", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "continued" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const toolAddition = {
      type: "tool_addition",
      tools: [{ name: "lookup" }]
    } as const;
    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-opus-5"),
      messages: [
        { role: "user", parts: [{ type: "text", text: "Start." }] },
        {
          role: "system",
          parts: [providerDataPart("anthropic", toolAddition)]
        },
        { role: "user", parts: [{ type: "text", text: "Continue." }] }
      ],
      providerOptions: {
        midConversationToolChanges: true
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = requestInit.headers as Record<string, string>;
    const body = JSON.parse(String(requestInit.body));
    expect(headers["anthropic-beta"]).toBe("mid-conversation-tool-changes-2026-07-01");
    expect(body.messages[1]).toEqual({
      role: "system",
      content: [toolAddition]
    });
    expect(body.midConversationToolChanges).toBeUndefined();
  });

  it("preserves valid mid-conversation system messages for Claude Sonnet 5", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-sonnet-5"),
      messages: [
        { role: "system", parts: [{ type: "text", text: "Initial instruction." }] },
        { role: "user", parts: [{ type: "text", text: "Start." }] },
        { role: "system", parts: [{ type: "text", text: "Apply this local instruction." }] },
        { role: "assistant", parts: [{ type: "text", text: "Ready." }] },
        { role: "user", parts: [{ type: "text", text: "Continue." }] }
      ]
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      system: string;
      messages: Array<{ role: string; content: unknown }>;
    };

    expect(body.system).toBe("Initial instruction.");
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Start." }] },
      { role: "system", content: "Apply this local instruction." },
      { role: "assistant", content: [{ type: "text", text: "Ready." }] },
      { role: "user", content: [{ type: "text", text: "Continue." }] }
    ]);
  });

  it("keeps legacy top-level system mapping before Claude Opus 4.8", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-opus-4-7"),
      messages: [
        { role: "user", parts: [{ type: "text", text: "Start." }] },
        { role: "system", parts: [{ type: "text", text: "Legacy local instruction." }] },
        { role: "user", parts: [{ type: "text", text: "Continue." }] }
      ]
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      system: string;
      messages: Array<{ role: string }>;
    };

    expect(body.system).toBe("Legacy local instruction.");
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Start." }] },
      { role: "user", content: [{ type: "text", text: "Continue." }] }
    ]);
  });

  it("rejects invalid mid-conversation system message placement for Claude Opus 4.8", async () => {
    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("claude-opus-4-8"),
        messages: [
          { role: "user", parts: [{ type: "text", text: "Start." }] },
          { role: "assistant", parts: [{ type: "text", text: "Ready." }] },
          { role: "system", parts: [{ type: "text", text: "Too late." }] }
        ]
      })
    ).rejects.toThrow(
      'Provider "anthropic" only supports mid-conversation system messages immediately after a user turn on Claude Opus 4.8 or later, Claude Sonnet 5, Claude Fable 5, or Claude Mythos 5.'
    );
  });

  it("maps Anthropic refusals and preserves stop details", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "I cannot help with that." }],
        stop_reason: "refusal",
        stop_details: { type: "refusal", reason: "safety" },
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("claude-opus-4-8"),
      prompt: "unsafe request"
    });

    expect(result.finishReason).toBe("refusal");
    expect(result.providerFinishReason).toBe("refusal");
    expect(result.steps[0]?.response.rawResponse).toMatchObject({
      stop_details: { type: "refusal", reason: "safety" }
    });
  });

  it("streams Anthropic refusal stop details as provider data", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "event: content_block_delta\n" +
              'data: {"index":0,"delta":{"type":"text_delta","text":"I cannot help with that."}}\n\n' +
              "event: message_delta\n" +
              'data: {"delta":{"stop_reason":"refusal","stop_details":{"type":"refusal","reason":"safety"}},"usage":{"input_tokens":10,"output_tokens":4,"speed":"fast"}}\n\n' +
              "event: message_stop\n" +
              "data: {}\n\n"
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

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("claude-opus-4-8"),
      prompt: "unsafe request"
    });

    const final = await result.collect();
    const events = [];
    for await (const event of result.eventStream) {
      events.push(event);
    }

    expect(final).toMatchObject({
      text: "I cannot help with that.",
      finishReason: "refusal",
      providerFinishReason: "refusal",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        speed: "fast"
      }
    });
    expect(events).toContainEqual({
      type: "provider-data",
      provider: "anthropic",
      data: {
        type: "stop_details",
        stop_details: { type: "refusal", reason: "safety" }
      }
    });
  });

  it("streams Anthropic fallback blocks as provider data", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "event: content_block_start\n" +
              'data: {"index":0,"content_block":{"type":"fallback","from":{"model":"claude-fable-5"},"to":{"model":"claude-opus-4-8"}}}\n\n' +
              "event: content_block_delta\n" +
              'data: {"index":1,"delta":{"type":"text_delta","text":"fallback served"}}\n\n' +
              "event: message_stop\n" +
              'data: {"stop_reason":"end_turn"}\n\n'
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

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("claude-fable-5"),
      prompt: "unsafe request",
      providerOptions: {
        fallbacks: [{ model: "claude-opus-4-8" }]
      }
    });

    const final = await result.collect();
    expect(final.text).toBe("fallback served");
    expect(final.messages.at(-1)?.parts).toContainEqual({
      type: "provider-data",
      provider: "anthropic",
      data: {
        type: "fallback",
        from: { model: "claude-fable-5" },
        to: { model: "claude-opus-4-8" }
      }
    });
  });

  it("maps PDF file parts into Anthropic document blocks and enables the Files API beta when needed", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-opus-4-7"),
      messages: [
        {
          role: "user",
          parts: [
            { type: "text", text: "Summarize this PDF." },
            {
              type: "file",
              data: "file_011CNha8iCJcU1wXNR6q4V8w",
              mediaType: "application/pdf",
              filename: "brief.pdf"
            }
          ]
        }
      ]
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = requestInit.headers as Record<string, string>;
    const body = JSON.parse(String(requestInit.body)) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };

    expect(headers["anthropic-beta"]).toContain("files-api-2025-04-14");
    expect(body.messages[0]?.content[1]).toEqual({
      type: "document",
      source: {
        type: "file",
        file_id: "file_011CNha8iCJcU1wXNR6q4V8w"
      },
      title: "brief.pdf"
    });
  });

  it("maps Anthropic MCP toolsets into native request fields", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-3-5-sonnet"),
      prompt: "hello",
      tools: {
        github: anthropicMcpToolset({
          server: {
            name: "github",
            url: "https://example.com/mcp",
            authorization_token: "secret"
          },
          default_config: {
            enabled: true
          }
        })
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = requestInit.headers as Record<string, string>;
    const body = JSON.parse(String(requestInit.body)) as {
      mcp_servers: Array<Record<string, unknown>>;
      tools: Array<Record<string, unknown>>;
    };

    expect(headers["anthropic-beta"]).toBe("mcp-client-2025-11-20");
    expect(body.mcp_servers).toEqual([
      {
        type: "url",
        name: "github",
        url: "https://example.com/mcp",
        authorization_token: "secret"
      }
    ]);
    expect(body.tools).toEqual([
      {
        type: "mcp_toolset",
        mcp_server_name: "github",
        default_config: {
          enabled: true
        }
      }
    ]);
  });

  it("parses Anthropic MCP blocks into provider-data parts", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [
          {
            type: "mcp_tool_use",
            id: "mcpu_1",
            name: "fetch_docs",
            server_name: "github",
            input: { path: "README.md" }
          },
          {
            type: "mcp_tool_result",
            tool_use_id: "mcpu_1",
            server_name: "github",
            content: { text: "ok" }
          }
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("claude-3-5-sonnet"),
      prompt: "hello",
      tools: {
        github: anthropicMcpToolset({
          server: {
            name: "github",
            url: "https://example.com/mcp"
          }
        })
      }
    });

    expect(result.messages.at(-1)?.parts).toEqual([
      {
        type: "provider-data",
        provider: "anthropic",
        data: {
          type: "mcp_tool_use",
          id: "mcpu_1",
          name: "fetch_docs",
          server_name: "github",
          input: {
            path: "README.md"
          }
        }
      },
      {
        type: "provider-data",
        provider: "anthropic",
        data: {
          type: "mcp_tool_result",
          tool_use_id: "mcpu_1",
          server_name: "github",
          content: {
            text: "ok"
          }
        }
      }
    ]);
  });

  it("streams Anthropic MCP blocks as provider-data events", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "event: content_block_start\n" +
              'data: {"index":0,"content_block":{"type":"mcp_tool_use","id":"mcpu_1","name":"fetch_docs","server_name":"github","input":{"path":"README.md"}}}\n\n' +
              "event: content_block_delta\n" +
              'data: {"index":1,"delta":{"type":"text_delta","text":"approved"}}\n\n' +
              "event: message_stop\n" +
              'data: {"stop_reason":"end_turn"}\n\n'
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

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("claude-3-5-sonnet"),
      prompt: "hello",
      tools: {
        github: anthropicMcpToolset({
          server: {
            name: "github",
            url: "https://example.com/mcp"
          }
        })
      }
    });

    const final = await result.collect();
    expect(final.text).toBe("approved");
    expect(final.messages.at(-1)?.parts).toContainEqual({
      type: "provider-data",
      provider: "anthropic",
      data: {
        type: "mcp_tool_use",
        id: "mcpu_1",
        name: "fetch_docs",
        server_name: "github",
        input: {
          path: "README.md"
        }
      }
    });
  });

  it("rejects unsupported reasoning effort for Anthropic", async () => {
    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("claude-3-5-sonnet"),
        prompt: "hello",
        reasoning: {
          effort: "medium"
        }
      })
    ).rejects.toThrow(/does not support "reasoning\.effort=medium"/);
  });

  it("rejects budgetTokens for Claude Opus 4.8", async () => {
    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("claude-opus-4-8"),
        prompt: "hello",
        reasoning: {
          budgetTokens: 1024
        }
      })
    ).rejects.toThrow(
      'Provider "anthropic" does not support "reasoning.budgetTokens" for Claude Opus 4.7 or later, Claude Sonnet 5, Claude Fable 5, or Claude Mythos 5; use "reasoning.effort" instead.'
    );
  });

  it("rejects budgetTokens for Claude Sonnet 5", async () => {
    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("claude-sonnet-5"),
        prompt: "hello",
        reasoning: {
          budgetTokens: 1024
        }
      })
    ).rejects.toThrow(
      'Provider "anthropic" does not support "reasoning.budgetTokens" for Claude Opus 4.7 or later, Claude Sonnet 5, Claude Fable 5, or Claude Mythos 5; use "reasoning.effort" instead.'
    );
  });

  it("rejects disabled or manual thinking on Claude Fable 5", async () => {
    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("claude-fable-5"),
        prompt: "hello",
        reasoning: {
          effort: "none"
        }
      })
    ).rejects.toThrow(/does not support reasoning effort "none"/);

    await expect(
      generateText({
        model: provider("claude-fable-5"),
        prompt: "hello",
        providerOptions: {
          thinking: {
            type: "disabled"
          }
        }
      })
    ).rejects.toThrow(
      'Provider "anthropic" does not support "thinking.disabled" for Claude Fable 5 or Claude Mythos 5; omit "thinking" or use "thinking.display" with adaptive thinking.'
    );

    await expect(
      generateText({
        model: provider("claude-fable-5"),
        prompt: "hello",
        reasoning: {
          budgetTokens: 1024
        }
      })
    ).rejects.toThrow(
      'Provider "anthropic" does not support "reasoning.budgetTokens" for Claude Opus 4.7 or later, Claude Sonnet 5, Claude Fable 5, or Claude Mythos 5; use "reasoning.effort" instead.'
    );
  });

  it.each(["claude-sonnet-4-6", "claude-opus-4-6"])(
    "rejects non-default temperature with adaptive thinking for %s before fetching",
    async (modelId) => {
      const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });

      await expect(
        generateText({
          model: provider(modelId),
          prompt: "hello",
          temperature: 0,
          reasoning: {
            effort: "low"
          }
        })
      ).rejects.toThrow(/only supports the default "temperature=1" when thinking is enabled or adaptive/);

      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("rejects explicit sampling controls for Claude Opus 4.8", async () => {
    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("claude-opus-4-8"),
        prompt: "hello",
        temperature: 0
      })
    ).rejects.toThrow(/only supports the default "temperature=1"/);

    await expect(
      generateText({
        model: provider("claude-opus-4-8"),
        prompt: "hello",
        providerOptions: {
          top_p: 0.9
        }
      })
    ).rejects.toThrow(/only supports default sampling controls/);
  });

  it("rejects explicit sampling controls for Claude Sonnet 5", async () => {
    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("claude-sonnet-5"),
        prompt: "hello",
        temperature: 0
      })
    ).rejects.toThrow(/only supports the default "temperature=1"/);

    await expect(
      generateText({
        model: provider("claude-sonnet-5"),
        prompt: "hello",
        providerOptions: {
          top_p: 0.9
        }
      })
    ).rejects.toThrow(/only supports default sampling controls/);
  });
});
