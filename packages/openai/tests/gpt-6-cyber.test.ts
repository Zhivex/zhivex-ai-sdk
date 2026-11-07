import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { generateText, tool } from "@zhivex-ai/core";
import { createOpenAI, openAIImageGenerationTool, openAIWebSearchTool } from "../src/index.js";
import { resolveOpenAIModelProfile } from "../src/model-profiles.js";

const completed = {
  id: "resp_cyber",
  status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }]
};
const chatCompleted = { choices: [{ finish_reason: "stop", message: { content: "ok" } }] };

describe("GPT-6-Cyber", () => {
  const fetchMock = vi.fn();
  const provider = () => createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
  const body = () => JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body)) as Record<string, unknown>;

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("advertises the published language contract and leaves dated ids unknown", () => {
    const model = provider()("gpt-6-cyber");
    expect(resolveOpenAIModelProfile("gpt-6-cyber")).toMatchObject({
      label: "GPT-6-Cyber",
      defaultApi: "responses",
      sampling: "allowed",
      toolsRequireResponses: "never",
      reasoningEfforts: undefined
    });
    expect(model.capabilities).toMatchObject({
      streaming: true,
      tools: true,
      structuredOutput: true,
      jsonMode: false,
      parallelToolCalls: false,
      vision: true,
      files: false,
      embeddings: false,
      reasoning: true,
      webSearch: true,
      explicitPromptCaching: true
    });
    expect(model.capabilities.reasoningEfforts).toBeUndefined();
    expect(model.capabilities.reasoningModes).toBeUndefined();
    expect(model.capabilities.reasoningContexts).toBeUndefined();
    expect(model.capabilities.agentCapabilities).toMatchObject({
      hostedWebSearch: true,
      hostedFileSearch: true,
      remoteMcp: true,
      computerUse: true,
      codeExecution: true,
      shell: true,
      applyPatch: true,
      skills: true,
      toolSearch: true,
      programmaticToolCalling: false,
      multiAgent: false
    });
    expect(provider()("gpt-6-cyber-2026-11-05").capabilities.tools).toBe(false);
    expect(provider()("gpt-image-2.6-flare").capabilities).toMatchObject({ tools: false, vision: false, reasoning: false });
  });

  it("sends Responses by default, forwards daybreak_red, and does not invent the access field", async () => {
    const model = provider()("gpt-6-cyber");
    fetchMock.mockResolvedValueOnce(Response.json(completed));
    await generateText({
      model,
      prompt: "Suggest a regression test for a path traversal fix.",
      reasoning: { effort: "low" },
      providerOptions: {
        access_programs: { cyber: "daybreak_red" },
        safety_identifier: "user_a17f"
      }
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/responses");
    expect(body()).toMatchObject({
      model: "gpt-6-cyber",
      reasoning: { effort: "low" },
      access_programs: { cyber: "daybreak_red" },
      safety_identifier: "user_a17f"
    });
    expect(body().reasoning).toEqual({ effort: "low" });

    fetchMock.mockResolvedValueOnce(Response.json(completed));
    await generateText({ model, prompt: "hello" });
    expect(body()).not.toHaveProperty("access_programs");
  });

  it("rejects undocumented access, summary, and embedding calls before fetch", async () => {
    const model = provider()("gpt-6-cyber");
    await expect(generateText({
      model,
      prompt: "hello",
      providerOptions: { access_programs: { cyber: "daybreak_blue" } }
    })).rejects.toThrow('daybreak_red');
    await expect(generateText({
      model,
      prompt: "hello",
      providerOptions: { apiMode: "chat", access_programs: { cyber: "daybreak_red" } }
    })).rejects.toThrow("Responses API");
    await expect(generateText({
      model,
      prompt: "hello",
      providerOptions: { access_programs: { cyber: "daybreak_red", extra: true } }
    })).rejects.toThrow("not a documented field");
    await expect(generateText({
      model,
      prompt: "hello",
      reasoning: { includeThoughts: true }
    })).rejects.toThrow("reasoning.summary");
    await expect(generateText({
      model,
      prompt: "hello",
      reasoning: { effort: "max" }
    })).rejects.toThrow('reasoning effort "max"');
    await expect(model.generate({
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
      providerOptions: { response_format: { type: "json_object" } }
    })).rejects.toThrow("JSON mode");
    await expect(provider().embeddingModel("gpt-6-cyber").embed({ values: ["hello"] })).rejects.toThrow("does not support embeddings");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends function tools on Chat Completions and hosted tools on Responses", async () => {
    const model = provider()("gpt-6-cyber");
    const echo = tool({ name: "echo", schema: z.object({}), execute: () => "ok" });
    fetchMock.mockResolvedValueOnce(Response.json(chatCompleted));
    await generateText({
      model,
      prompt: "hello",
      tools: { echo },
      providerOptions: { apiMode: "chat" }
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/chat/completions");
    expect(body().tools).toEqual([expect.objectContaining({ type: "function" })]);

    fetchMock.mockResolvedValueOnce(Response.json(completed));
    await generateText({
      model,
      messages: [{
        role: "user",
        parts: [
          { type: "text", text: "describe" },
          { type: "image", image: "aaaa", mediaType: "image/png" }
        ]
      }],
      tools: { search: openAIWebSearchTool() }
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.openai.com/v1/responses");
    expect(body().tools).toEqual([expect.objectContaining({ type: "web_search" })]);
    expect(JSON.stringify(body().input)).toContain("input_image");

    expect(() => openAIImageGenerationTool({ model: "gpt-image-2.6-flare" })).toThrow("Image API");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
