import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTextMessage, generateText } from "@zhivex-ai/core";
import { createOllama } from "../src/index.ts";

describe("ollama adapter", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("maps generated text into the common contract", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        response: "hello from ollama",
        prompt_eval_count: 5,
        eval_count: 4,
        done_reason: "stop"
      })
    );

    const provider = createOllama({ fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("llama3.2"),
      prompt: "hello"
    });

    expect(result.text).toBe("hello from ollama");
    expect(result.usage?.totalTokens).toBe(9);
  });

  it("creates equivalent language models from the callable provider", () => {
    const provider = createOllama({ fetch: fetchMock as typeof fetch });

    expect(provider("llama3.2")).toMatchObject(provider.languageModel("llama3.2"));
  });

  it("sends last user images as base64 payloads", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ response: "ok" }));

    const provider = createOllama({ fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("llava"),
      messages: [
        createTextMessage("assistant", "context"),
        {
          role: "user",
          parts: [
            { type: "text", text: "describe" },
            { type: "image", image: "data:image/png;base64,aGVsbG8=", mediaType: "image/png" }
          ]
        }
      ]
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { images: string[] };
    expect(body.images).toEqual(["aGVsbG8="]);
  });

  it("surfaces invalid model errors as validation errors", async () => {
    fetchMock.mockRejectedValueOnce(new Error("model not found"));

    const provider = createOllama({ fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("missing"),
        messages: [createTextMessage("user", "hello")]
      })
    ).rejects.toThrow("model not found");
  });
});
