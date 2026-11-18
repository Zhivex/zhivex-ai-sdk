import { describe, expect, it, vi } from "vitest";

import { createGemini } from "@zhivex-ai/gemini";
import { createVertex } from "../../vertex/src/index.js";
import { defaultModelCatalog, streamText, tool, type InteractionCreateInput, type ModelGenerateInput } from "@zhivex-ai/sdk";
import { z } from "zod";

const modelId = "gemini-4-neon";
const messages: ModelGenerateInput["messages"] = [
  { role: "system", parts: [{ type: "text", text: "Be accurate." }] },
  { role: "user", parts: [{ type: "text", text: "Solve the problem." }] }
];
const input: ModelGenerateInput = { messages, maxTokens: 130000, reasoning: { effort: "xhigh" } };
const interaction: InteractionCreateInput = {
  modelId, input: "Solve the problem.", generationConfig: { thinking_level: "xhigh", max_output_tokens: 130000 }
};
const candidate = (text: string, finishReason: string, continuationToken?: string) => ({
  candidates: [{ index: 0, finishReason, continuationToken, content: { parts: [{ text }] } }]
});
const usage = (inputTokens: number, outputTokens: number) => ({
  promptTokenCount: inputTokens, candidatesTokenCount: outputTokens, totalTokenCount: inputTokens + outputTokens
});
const within = (inputTokens: number, outputTokens: number) => ({
  total_input_tokens: inputTokens, total_output_tokens: outputTokens, total_tokens: inputTokens + outputTokens
});
const sse = (...events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
  headers: { "content-type": "text/event-stream" }
});
const client = (provider: string, ...responses: Array<Response | (() => Response)>) => {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) fetcher.mockImplementationOnce(async () => typeof response === "function" ? response() : response);
  const sdk = provider === "vertex"
    ? createVertex({ accessToken: "test", projectId: "test-project", location: "global", fetch: fetcher })
    : createGemini({ apiKey: "test", fetch: fetcher });
  const requests = () => fetcher.mock.calls.map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init?.body)) }));
  return { sdk, fetcher, requests };
};

describe.each(["gemini", "vertex"])("Gemini 4 Neon on %s", (provider) => {
  it("registers paid pricing and advertises supported reasoning", () => {
    const { sdk } = client(provider);
    expect(defaultModelCatalog.find(provider, modelId)).toMatchObject({
      contextWindowType: "combined", maxOutputTokens: 1048576, contextWindowTokens: 1048576,
      inputCostPer1kTokens: 0.003, cachedInputCostPer1kTokens: 0.00015, outputCostPer1kTokens: 0.015
    });
    expect(sdk(modelId).capabilities).toMatchObject({
      reasoningEfforts: ["low", "medium", "high", "xhigh"], contextCaching: false
    });
  });

  it("replays original GenerateContent requests and merges content and billed usage", async () => {
    const { sdk, requests } = client(provider,
      Response.json({ ...candidate("", "CONTINUATION", "first"), usageMetadata: { ...usage(10, 0), thoughtsTokenCount: 65536 } }),
      Response.json({ ...candidate("Part one. ", "CONTINUATION", "second"), usageMetadata: usage(100, 5) }),
      Response.json({ ...candidate("Part two.", "STOP"), usageMetadata: usage(200, 4) })
    );
    const result = await sdk(modelId).generate({
      ...input, tools: { lookup: tool({ schema: z.object({}), execute: async () => "ok" }) }
    });
    expect(result).toMatchObject({
      text: "Part one. Part two.", providerRequestCount: 3, providerFinishReason: "STOP",
      usage: { inputTokens: 310, outputTokens: 9, totalTokens: 319, reasoningTokens: 65536 },
      rawResponse: { usageMetadata: { initialPromptTokenCount: 10 } }
    });
    const [first, second, third] = requests();
    expect(first?.url).toContain(provider === "vertex" ? "/v1beta1/" : "/v1beta/");
    expect(first?.body.generationConfig).toEqual({ maxOutputTokens: 130000, thinkingConfig: { thinkingLevel: "XHIGH" } });
    expect(first?.body.tools).toBeDefined();
    expect(second?.body).toEqual({ ...first?.body, continuationToken: "first" });
    expect(third?.body).toEqual({ ...first?.body, continuationToken: "second" });
  });

  it("streams one logical turn and sums the last usage update from each segment", async () => {
    const { sdk, requests } = client(provider,
      sse({ ...candidate("Part one. ", "CONTINUATION", "first"), usageMetadata: usage(6, 1) }, { usageMetadata: usage(6, 4) }),
      sse({ ...candidate("Part two.", "STOP"), usageMetadata: usage(13, 7) })
    );
    const events = await Array.fromAsync(await sdk(modelId).stream!(input));
    expect(events.filter((event) => event.type === "text-delta").map((event) => event.textDelta)).toEqual(["Part one. ", "Part two."]);
    expect(events.filter((event) => event.type === "finish")).toEqual([
      expect.objectContaining({ finishReason: "stop", providerRequestCount: 2, usage: expect.objectContaining({
        inputTokens: 19, outputTokens: 11, totalTokens: 30
      }) })
    ]);
    expect(requests()[1]?.body).toEqual({ ...requests()[0]?.body, continuationToken: "first" });
  });

  it("replays thought signatures and parallel tool results with inline documents", async () => {
    const { sdk, requests } = client(provider,
      sse({ candidates: [{ finishReason: "STOP", content: { parts: [
        { text: "Private thought", thought: true },
        { text: "Calling tools.", thoughtSignature: "text-signature" },
        { functionCall: { id: "first", name: "lookup", args: {} }, thoughtSignature: "tool-signature" },
        { functionCall: { id: "second", name: "lookup", args: {} } }
      ] } }] }),
      sse(candidate("Done.", "STOP"))
    );
    const result = await streamText({
      model: sdk(modelId), maxSteps: 2, messages: [...messages, {
        role: "user", parts: [{
          type: "file", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          data: "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,YQ=="
        }]
      }],
      tools: { lookup: tool({ schema: z.object({}), execute: async () => "ok" }) }
    }).collect();
    expect(result.text).toBe("Calling tools.Done.");
    expect(requests()[0]?.body.contents.at(-1)?.parts).toEqual([{
      inlineData: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data: "YQ==" }
    }]);
    expect(requests()[1]?.body.contents.slice(-2)).toEqual([
      { role: "model", parts: [
        { text: "Calling tools.", thoughtSignature: "text-signature" },
        { functionCall: { id: "first", name: "lookup", args: {} }, thoughtSignature: "tool-signature" },
        { functionCall: { id: "second", name: "lookup", args: {} } }
      ] },
      { role: "user", parts: ["first", "second"].map((id) => ({
        functionResponse: { id, name: "lookup", response: { name: "lookup", content: "ok" } }
      })) }
    ]);
  });

  it("does not open another segment after the caller aborts", async () => {
    const { sdk, fetcher } = client(provider, sse(candidate("Partial", "CONTINUATION", "first")));
    const abort = new AbortController();
    const stream = await sdk(modelId).stream!({ ...input, abortSignal: abort.signal });
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "text-delta", textDelta: "Partial" });
    abort.abort(new Error("stop now"));
    await expect(iterator.next()).rejects.toThrow("stop now");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("honors the output budget and rejects repeated continuation tokens", async () => {
    const exhausted = client(provider, Response.json(candidate("Partial", "MAX_TOKENS", "saved")));
    expect(await exhausted.sdk(modelId).generate(input)).toMatchObject({ text: "Partial", finishReason: "length" });
    expect(exhausted.fetcher).toHaveBeenCalledTimes(1);

    const repeated = client(provider, Response.json(candidate("", "CONTINUATION", "same")), Response.json(candidate("", "CONTINUATION", "same")));
    await expect(repeated.sdk(modelId).generate(input)).rejects.toThrow("missing or repeated continuation token");
    expect(repeated.fetcher).toHaveBeenCalledTimes(2);
  });

  it("blocks unsupported options before fetching", async () => {
    const { sdk, fetcher } = client(provider);
    await expect(sdk(modelId).generate({ ...input, temperature: 0.2 })).rejects.toThrow("temperature");
    await expect(sdk(modelId).generate({ ...input, reasoning: { effort: "minimal" } })).rejects.toThrow("minimal");
    await expect(sdk(modelId).generate({ ...input, reasoning: { budgetTokens: 2048 } })).rejects.toThrow("budgetTokens");
    await expect(sdk(modelId).generate({ ...input, providerOptions: { cachedContent: "cachedContents/test" } })).rejects.toThrow("implicit caching");
    await expect(sdk.interactions!.create({ ...interaction, background: true, store: false })).rejects.toThrow("store: true");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([true, false])("follows foreground interactions with store: %s", async (store) => {
    const { sdk, requests } = client(provider,
      Response.json({ id: "one", status: "requires_continuation", continuation_token: "next", outputs: [{ type: "text", text: "Part one. " }], usage: within(6, 4) }),
      Response.json({ id: "two", status: "completed", outputs: [{ type: "text", text: "Part two." }], usage: within(13, 7) })
    );
    expect(await sdk.interactions!.create({ ...interaction, store })).toMatchObject({
      id: "two", continuationIds: ["one", "two"], status: "completed", initialInputTokens: 6,
      usage: { inputTokens: 19, outputTokens: 11, totalTokens: 30 }, outputText: "Part one. Part two."
    });
    expect(requests()[1]?.body).toEqual({
      model: modelId, store, generation_config: interaction.generationConfig, continuation_token: "next",
      ...(store ? { previous_interaction_id: "one" } : { input: interaction.input }),
      ...(provider === "vertex" ? { stream: false } : {})
    });
  });

  it("exposes budget-exhaustion checkpoints and accepts an explicit stored continuation", async () => {
    const { sdk, requests } = client(provider,
      Response.json({ id: "one", status: "incomplete", continuation_token: "next", outputs: [{ type: "text", text: "Part one. " }] }),
      Response.json({ id: "two", status: "completed", outputs: [{ type: "text", text: "Part two." }] })
    );
    const part = await sdk.interactions!.create(interaction);
    expect(part).toMatchObject({ status: "incomplete", continuationToken: "next" });
    const result = await sdk.interactions!.create({
      modelId, previousInteractionId: part.id, continuationToken: part.continuationToken,
      generationConfig: { max_output_tokens: 260000 }, automaticContinuation: false
    });
    expect(result).toMatchObject({ id: "two", outputText: "Part two." });
    expect(requests()[1]?.body).toMatchObject({ previous_interaction_id: "one", continuation_token: "next" });
    expect(requests()[1]?.body).not.toHaveProperty("input");
  });

  it("streams Interaction checkpoints and a single finish across segments", async () => {
    const { sdk, requests } = client(provider,
      sse(
        { event_type: "interaction.created", interaction: { id: "one" } },
        { event_type: "step.delta", delta: { type: "text", text: "Part one. " } },
        { event_type: "interaction.completed", interaction: { id: "one", status: "requires_continuation", continuation_token: "next", usage: within(6, 4) } }
      ),
      sse(
        { event_type: "step.delta", delta: { type: "text", text: "Part two." } },
        { event_type: "interaction.completed", interaction: { id: "two", status: "completed", usage: within(13, 7) } }
      )
    );
    const events = await Array.fromAsync(await sdk.interactions!.stream(interaction));
    expect(events.filter((event) => event.type === "text-delta").map((event) => event.textDelta)).toEqual(["Part one. ", "Part two."]);
    expect(events.filter((event) => event.type === "finish")).toEqual([
      expect.objectContaining({ finishReason: "stop", providerRequestCount: 2, usage: expect.objectContaining({ inputTokens: 19, outputTokens: 11 }) })
    ]);
    expect(requests()[1]?.body).toMatchObject({ previous_interaction_id: "one", continuation_token: "next", stream: true });
  });
});

it("enforces supported Vertex locations", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const sdk = createVertex({ accessToken: "test", projectId: "test-project", location: "us-central1", fetch: fetcher });
  expect(() => sdk(modelId)).toThrow(/global.*us.*eu/);
  await expect(sdk.interactions.create(interaction)).rejects.toThrow(/global, us, or eu/);
  expect(fetcher).not.toHaveBeenCalled();
});

it("keeps explicitly requested Vertex v1 for short requests and rejects long decodes on it", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(candidate("Ready", "STOP")));
  const sdk = createVertex({
    accessToken: "test", projectId: "test-project", location: "eu", apiVersion: "v1", fetch: fetcher
  });
  await expect(sdk(modelId).generate(input)).rejects.toThrow("v1beta1");
  await expect(sdk(modelId).generate({ messages })).resolves.toMatchObject({ text: "Ready" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0]?.[0])).toContain("/v1/projects/test-project/locations/eu/");
});
