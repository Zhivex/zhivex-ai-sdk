import { describe, it, expect, vi } from "vitest";
import { createVertex } from "../src/index.js";
import { googleMapsTool, googleFileSearchTool, hostedTool } from "@zhivex-ai/core";

const setup = () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  return { fetch, interactions: createVertex({ projectId: "p", location: "global", accessToken: "token", fetch }).interactions };
};
describe("Vertex project-scoped Interactions", () => {
  it("routes Gemini Omni text and image video through Interactions", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({ id: "v1", status: "completed", steps: [{ type: "model_output", content: [{ type: "video", data: "AQI=", mime_type: "video/mp4" }] }] }))
      .mockResolvedValueOnce(Response.json({ id: "v2", status: "completed", outputs: [{ type: "video", uri: "gs://bucket/result.mp4", mime_type: "video/mp4" }] }));
    const provider = createVertex({ projectId: "p", accessToken: "token", location: "global", fetch });
    const result = await provider.videoGenerationModel!("gemini-omni-flash-preview").generateVideo({ prompt: "ocean", durationSeconds: 3, aspectRatio: "16:9", providerOptions: { resolution: "720p" } });
    expect(result.videos[0].data).toEqual(new Uint8Array([1, 2]));
    expect(String(fetch.mock.calls[0][0])).toBe("https://aiplatform.googleapis.com/v1beta1/projects/p/locations/global/interactions");
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({ model: "gemini-omni-flash-preview", response_format: [{ type: "video", duration: "3s", aspect_ratio: "16:9", resolution: "720p" }], generation_config: { video_config: { task: "text_to_video" } }, background: false, store: false });
    const imageResult = await provider.videoGenerationModel!("gemini-omni-1.1-flash-preview").generateVideo({ prompt: "animate", image: { mediaType: "image/png", data: new Uint8Array([1, 2]) }, outputStorageUri: "gs://bucket/output/", providerOptions: { resolution: "1080p" } });
    expect(imageResult.videos[0].uri).toBe("gs://bucket/result.mp4");
    expect(JSON.parse(fetch.mock.calls[1][1]!.body as string)).toMatchObject({ input: [{ type: "text", text: "animate" }, { type: "image", data: "AQI=", mime_type: "image/png" }], response_format: [{ type: "video", delivery: "uri", gcs_uri: "gs://bucket/output/", resolution: "1080p" }], generation_config: { video_config: { task: "image_to_video" } } });
  });
  it("rejects invalid Omni controls and incomplete video responses", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = createVertex({ projectId: "p", accessToken: "token", location: "global", fetch });
    const model = provider.videoGenerationModel!("gemini-omni-flash-preview");
    for (const extra of [{ count: 2 }, { pollIntervalMs: 1000 }, { durationSeconds: 2 }, { durationSeconds: 3.5 }, { aspectRatio: "1:1" }, { negativePrompt: "no rain" }, { outputStorageUri: "https://example.com/out" }, { providerOptions: { resolution: "1080p" } }, { providerOptions: { task: "edit" } }]) {
      await expect(model.generateVideo({ prompt: "ocean", ...extra })).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValue(Response.json({ id: "v1", status: "in_progress", outputs: [] }));
    await expect(model.generateVideo({ prompt: "ocean" })).rejects.toThrow("completed video");
  });
  it("maps hosted Maps and Vertex retrieval tools to the Interactions contract", async () => {
    const { fetch, interactions } = setup();
    fetch.mockResolvedValue(Response.json({ id: "i1", status: "completed", outputs: [] }));
    await interactions.create({ agent: "deep-research-preview-04-2026", input: "search", tools: {
      maps: googleMapsTool({ enableWidget: true, latitude: 1, longitude: 2 }),
      search: hostedTool({ name: "search", type: "vertexSearch", config: { datastores: ["projects/p/locations/global/collections/default_collection/dataStores/d"] } })
    } });
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).tools).toEqual([
      { type: "google_maps", enable_widget: true, latitude: 1, longitude: 2 },
      { type: "retrieval", retrieval_types: ["vertex_ai_search"], vertex_ai_search_config: { datastores: ["projects/p/locations/global/collections/default_collection/dataStores/d"] } }
    ]);
    await expect(interactions.create({ agent: "deep-research-preview-04-2026", input: "search", tools: { files: googleFileSearchTool(["store"]) } })).rejects.toThrow("does not expose hosted tool");
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("preserves lyrics, captions and audio from separate model output steps", async () => {
    const { fetch, interactions } = setup();
    fetch.mockResolvedValue(Response.json({ id: "music", status: "completed", steps: [
      { type: "thought", content: [{ type: "text", text: "internal" }] },
      { type: "model_output", content: [{ type: "text", text: "lyrics\n" }] },
      { type: "model_output", content: [{ type: "text", text: "caption" }] },
      { type: "model_output", content: [{ type: "audio", mime_type: "audio/mpeg", data: "AQI=" }] }
    ] }));
    const result = await interactions.get({ id: "music" });
    expect(result.outputs).toHaveLength(3);
    expect(result.outputText).toBe("lyrics\ncaption");
    expect(result.outputAudio).toMatchObject({ data: "AQI=" });
  });
  it.each(["index", "id", "completed-id", "negative-index", "invalid-arguments"])("rejects ambiguous tool events: %s", async (scenario) => {
    const { fetch, interactions } = setup();
    const start = { event_type: "step.start", index: 0, step: { type: "function_call", id: "c1", name: "lookup", arguments: {} } };
    const events: unknown[] = [start];
    if (scenario === "completed-id") events.push({ event_type: "step.stop", index: 0 });
    if (scenario === "invalid-arguments") events.push({ event_type: "step.delta", index: 0, delta: { type: "arguments", partial_arguments: "null" } }, { event_type: "step.stop", index: 0 });
    else events.push({ ...start, index: scenario === "index" ? 0 : scenario === "negative-index" ? -1 : 1, step: { ...start.step, id: scenario === "index" ? "c2" : "c1" } });
    fetch.mockResolvedValue(new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
    await expect((async () => { for await (const _ of await interactions.stream({ agent: "a", input: "lookup" })) { /* consume */ } })()).rejects.toThrow(scenario === "invalid-arguments" ? "must be an object" : "duplicate");
  });
  it("stops at the terminal event and cancels the remaining response", async () => {
    const { fetch, interactions } = setup();
    const cancel = vi.fn();
    fetch.mockResolvedValue(new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"event_type":"interaction.cancelled"}\n\ndata: {"event_type":"step.delta","delta":{"type":"text","text":"late"}}\n\n'));
    }, cancel })));
    const events = [];
    for await (const event of await interactions.resume({ id: "i1" })) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "error", providerFinishReason: "cancelled" });
    expect(events.some((event) => event.type === "text-delta")).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("routes the music facade to Interactions for Lyria 3", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ id: "i1", status: "completed", outputs: [{ type: "audio", data: "AQI=", mime_type: "audio/mpeg" }] }));
    const vertex = createVertex({ projectId: "p", location: "global", accessToken: "token", fetch });
    const result = await vertex.musicGenerationModel!("lyria-3-clip-preview").generateMusic({ prompt: "jazz", images: [{ mediaType: "image/png", data: new Uint8Array([1, 2]) }] });
    expect(result.audio[0].data).toEqual(new Uint8Array([1, 2]));
    expect(String(fetch.mock.calls[0][0])).toContain("/interactions");
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({ model: "lyria-3-clip-preview", input: [{ type: "text", text: "jazz" }, { type: "image", mime_type: "image/png", data: "AQI=" }] });
  });
  it("creates Lyria interactions and normalizes legacy multimedia outputs", async () => {
    const { fetch, interactions } = setup();
    fetch.mockResolvedValue(Response.json({ id: "i1", status: "completed", outputs: [{ type: "text", text: "lyrics" }, { type: "audio", mime_type: "audio/mpeg", data: "AQI=" }] }));
    const result = await interactions.create({ modelId: "lyria-3-clip-preview", input: "jazz", providerOptions: { model: "incorrect", stream: true } });
    expect(String(fetch.mock.calls[0][0])).toBe("https://aiplatform.googleapis.com/v1beta1/projects/p/locations/global/interactions");
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer token");
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({ model: "lyria-3-clip-preview", stream: false, store: false });
    expect(result.outputText).toBe("lyrics");
    expect(result.outputAudio).toMatchObject({ data: "AQI=" });
  });
  it("lists metadata, reads steps, and deletes empty responses", async () => {
    const { fetch, interactions } = setup();
    fetch.mockResolvedValueOnce(Response.json({ interaction_metadatas: [{ id: "i1" }], next_page_token: "next" }))
      .mockResolvedValueOnce(Response.json({ id: "i1", steps: [{ type: "model_output", content: [{ type: "video", uri: "gs://bucket/movie" }] }] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await interactions.list({ pageSize: 2, pageToken: "a b" })).toMatchObject({ interactions: [{ id: "i1" }], nextPageToken: "next" });
    expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get("page_token")).toBe("a b");
    expect((await interactions.get({ id: "i1" })).outputVideo?.uri).toBe("gs://bucket/movie");
    expect(await interactions.delete({ id: "i1" })).toEqual({ id: "i1" });
  });
  it("rejects stored Lyria Clip interactions before sending but preserves agent storage choices", async () => {
    const { fetch, interactions } = setup();
    await expect(interactions.create({ modelId: "lyria-3-clip-preview", input: "music", store: true })).rejects.toThrow("requires store: false");
    await expect(interactions.stream({ modelId: "lyria-3-clip-preview", input: "music", store: true })).rejects.toThrow("requires store: false");
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValue(Response.json({ id: "one", status: "in_progress" }));
    await interactions.create({ agent: "deep-research-preview-04-2026", input: "research", store: true });
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).store).toBe(true);
  });
  it("preserves resumable event IDs and media while normalizing streaming text", async () => {
    const { fetch, interactions } = setup();
    const data = [
      { event_type: "step.delta", event_id: "e1", delta: { type: "text", text: "hello" } },
      { event_type: "step.delta", event_id: "e2", delta: { type: "audio", data: "AQI=" } },
      { event_type: "interaction.completed", interaction: { status: "completed", usage: { total_output_tokens: 3 } } }
    ];
    fetch.mockResolvedValue(new Response(data.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
    const events = [];
    for await (const event of await interactions.resume({ id: "i1", lastEventId: "previous" })) events.push(event);
    expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get("last_event_id")).toBe("previous");
    expect(events).toContainEqual({ type: "text-delta", textDelta: "hello" });
    expect(events).toContainEqual(expect.objectContaining({ type: "provider-data", data: expect.objectContaining({ event_id: "e2", delta: { type: "audio", data: "AQI=" } }) }));
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "stop", usage: { outputTokens: 3 } });
  });
  it("restores partial tool arguments without re-emitting already completed calls", async () => {
    const { fetch, interactions } = setup();
    const previousEvents = [
      { event_type: "interaction.created", interaction: { id: "i1" } },
      { event_type: "step.start", index: 0, step: { type: "function_call", id: "done-call", name: "first", arguments: {} } },
      { event_type: "step.stop", index: 0 },
      { event_type: "step.start", index: 1, step: { type: "function_call", id: "pending-call", name: "lookup" } },
      { event_type: "step.delta", index: 1, delta: { type: "arguments_delta", partial_arguments: '{"city":"Pa' }, event_id: "cursor" }
    ];
    fetch.mockResolvedValue(new Response([
      { event_type: "step.delta", index: 1, delta: { type: "arguments_delta", partial_arguments: 'ris"}' } },
      { event_type: "step.stop", index: 1 },
      { event_type: "interaction.requires_action", status: "requires_action" }
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("")));
    const events = [];
    for await (const event of await interactions.resume({ id: "i1", lastEventId: "cursor", previousEvents })) events.push(event);
    expect(events.filter(event => event.type === "tool-call")).toEqual([
      { type: "tool-call", toolCall: { id: "pending-call", name: "lookup", input: { city: "Paris" } } }
    ]);
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "tool-calls" });
    expect(fetch.mock.calls[0][1]?.body).toBeUndefined();
    expect(events.filter(event => event.type === "provider-data")).toHaveLength(3);
  });
  it("rejects inconsistent replay history before fetching", async () => {
    const { fetch, interactions } = setup();
    const histories = [
      [{ event_type: "step.delta", event_id: "different" }],
      [{ event_type: "interaction.created", interaction: { id: "other" }, event_id: "cursor" }],
      [{ event_type: "step.delta", index: 1, delta: { type: "arguments_delta", partial_arguments: "{}" }, event_id: "cursor" }],
      [{ event_type: "step.start", index: 0, step: { type: "function_call", id: "duplicate", name: "x" } },
       { event_type: "step.start", index: 1, step: { type: "function_call", id: "duplicate", name: "x" }, event_id: "cursor" }],
      [{ event_type: "step.delta", event_id: "cursor" }, { event_type: "step.stop", index: 0 }]
    ];
    for (const previousEvents of histories) {
      await expect(interactions.resume({ id: "i1", lastEventId: "cursor", previousEvents })).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("recovers interrupted text from the last delivered cursor without replaying prior text", async () => {
    const { fetch, interactions } = setup();
    const encode = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
    fetch.mockResolvedValueOnce(encode([
      { event_type: "interaction.created", interaction: { id: "i1", status: "in_progress" }, event_id: "created" },
      { event_type: "step.delta", index: 0, delta: { type: "text", text: "Hello " }, event_id: "cursor+/=" }
    ])).mockResolvedValueOnce(encode([
      { event_type: "step.delta", index: 0, delta: { type: "text", text: "world" }, event_id: "next" },
      { event_type: "interaction.completed", interaction: { status: "completed" }, event_id: "done" }
    ]));
    let text = "", cursor: string | undefined;
    const consume = async (stream: Awaited<ReturnType<typeof interactions.resume>>) => {
      for await (const event of stream) {
        if (event.type === "text-delta") text += event.textDelta;
        if (event.type === "provider-data" && event.data && typeof event.data === "object" && "event_id" in event.data) {
          cursor = String(event.data.event_id);
        }
      }
    };
    await expect(consume(await interactions.stream({ modelId: "lyria-3-clip-preview", input: "A short greeting song" }))).rejects.toThrow("without a terminal event");
    expect(text).toBe("Hello ");
    expect(cursor).toBe("cursor+/=");
    await consume(await interactions.resume({ id: "i1", lastEventId: cursor }));
    const resumed = new URL(String(fetch.mock.calls[1][0]));
    expect(fetch.mock.calls[1][1]?.method).toBe("GET");
    expect(resumed.pathname).toMatch(/\/interactions\/i1$/);
    expect(resumed.searchParams.get("last_event_id")).toBe("cursor+/=");
    expect(resumed.searchParams.get("stream")).toBe("true");
    expect(text).toBe("Hello world");
    expect(cursor).toBe("done");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("cancels through the project-scoped path used by the official Google SDK", async () => {
    const { fetch, interactions } = setup();
    fetch.mockResolvedValue(Response.json({ id: "i1", status: "cancelled" }));
    expect((await interactions.cancel({ id: "i1" })).status).toBe("cancelled");
    expect(String(fetch.mock.calls[0][0])).toBe("https://aiplatform.googleapis.com/v1beta1/projects/p/locations/global/interactions/i1/cancel");
    expect(fetch.mock.calls[0][1]?.method).toBe("POST");
  });
  it("assembles streamed tool arguments and does not emit incomplete calls", async () => {
    const { fetch, interactions } = setup();
    const encode = (events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
    const start = { event_type: "step.start", index: 0, step: { type: "function_call", id: "call1", name: "lookup" } };
    const deltas = [
      { event_type: "step.delta", index: 0, delta: { type: "arguments_delta", partial_arguments: '{"city":' } },
      { event_type: "step.delta", index: 0, delta: { type: "arguments_delta", partial_arguments: '"Paris"}' } }
    ];
    fetch.mockResolvedValueOnce(encode([start, ...deltas, { event_type: "step.stop", index: 0 }, { event_type: "interaction.requires_action", status: "requires_action" }]))
      .mockResolvedValueOnce(encode([start, deltas[0]]));
    const events = [];
    for await (const event of await interactions.stream({ agent: "agent", input: "lookup" })) events.push(event);
    expect(events).toContainEqual({ type: "tool-call", toolCall: { id: "call1", name: "lookup", input: { city: "Paris" } } });
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "tool-calls" });
    const interrupted: unknown[] = [];
    await expect((async () => { for await (const event of await interactions.stream({ agent: "agent", input: "lookup" })) interrupted.push(event); })()).rejects.toThrow("terminal event");
    expect(interrupted).not.toContainEqual(expect.objectContaining({ type: "tool-call" }));
  });
  it("rejects disconnected streams, errors, unsafe IDs and unavailable auth", async () => {
    const { fetch, interactions } = setup();
    fetch.mockResolvedValue(new Response('data: {"event_type":"step.delta","delta":{"type":"text","text":"partial"}}\n\n'));
    await expect((async () => { for await (const _ of await interactions.stream({ modelId: "lyria-3-clip-preview", input: "music" })) { /* consume */ } })()).rejects.toThrow("terminal event");
    await expect(interactions.get({ id: "../outside" })).rejects.toThrow("Invalid");

    await expect(createVertex({ apiKey: "key" }).interactions.create({ modelId: "lyria-3-clip-preview", input: "music" })).rejects.toThrow();
  });
  it("fails before streaming on HTTP errors and enforces location", async () => {
    const { fetch, interactions } = setup();
    fetch.mockResolvedValue(Response.json({ error: "forbidden" }, { status: 403 }));
    await expect(interactions.stream({ modelId: "lyria-3-clip-preview", input: "music", maxRetries: 0 })).rejects.toMatchObject({ status: 403 });
    const regional = createVertex({ projectId: "p", location: "us-central1", accessToken: "token", fetch });
    await expect(regional.interactions.create({ modelId: "lyria-3-clip-preview", input: "music" })).rejects.toThrow("global");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
