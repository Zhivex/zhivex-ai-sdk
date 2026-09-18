import { createOmniRoutes } from "../examples/react-omni/routes.ts";
import { createQwen } from "../packages/qwen/src/index.ts";
import { createRealtimeRelay } from "../packages/react/src/realtime-server.ts";
import type { AgentLiveEvent, RealtimeSession } from "../packages/core/src/types.ts";
let toolExecutions = 0;
let omniRequests = 0;
let mediaTypes: string[] = [];
let audioFrames = 0;
let interruptions = 0;
const omni = createOmniRoutes(createQwen({ apiKey: "offline-fixture", fetch: async (_url, init) => {
  omniRequests++;
  const body = JSON.parse(String(init?.body));
  if (body.model !== "qwen3.8-omni-flash") throw new Error("Wrong model");
  mediaTypes = body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content.map((part: any) => part.type) : []);
  const toolDone = body.messages.some((message: any) => message.role === "tool");
  const delta = toolDone ? { content: "Media reviewed with approved context." } : { tool_calls: [{ index: 0, id: "omni-lookup", type: "function", function: { name: "lookup_media_context", arguments: "{}" } }] };
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: toolDone ? "stop" : "tool_calls" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
} })("qwen3.8-omni-flash"), () => { toolExecutions++; });
import { InMemoryChatReplayStore } from "../packages/react/src/replay.ts";
const output = await Bun.build({ entrypoints: ["packages/react/browser/fixture.tsx"], target: "browser", outdir: ".cache/react-browser", sourcemap: "inline" });
if (!output.success) throw new Error(output.logs.join("\n"));
const store = new InMemoryChatReplayStore({ maxStreams: 100 });
let runs = 0;
let reconnects = 0;
Bun.serve<{ relay?: ReturnType<typeof createRealtimeRelay> }>({ hostname: "127.0.0.1", port: 4178, async fetch(request, server) {
  const url = new URL(request.url);
  if (url.pathname === "/voice") return server.upgrade(request, { data: {} }) ? undefined : new Response("upgrade", { status: 426 });
  if (url.pathname.startsWith("/omni")) return omni.handle(request, "fixture-user");
  if (url.pathname === "/chat") {
    if (request.method === "GET") {
      reconnects++;
      return store.response({ streamId: url.searchParams.get("streamId")!, after: Number(url.searchParams.get("after")), ownerId: "fixture", signal: request.signal });
    }
    if (request.method === "DELETE") {
      store.cancel(url.searchParams.get("streamId")!, "fixture");
      return new Response(null, { status: 204 });
    }
    runs++;
    const streamId = store.create({ ownerId: "fixture", source: async function* (signal) {
      for (let i = 0; i < 10; i++) {
        await Bun.sleep(request.headers.get("x-slow") === "true" ? 180 : 60);
        if (signal.aborted) return;
        yield { type: "text-delta", messageId: `answer-${streamId}`, role: "assistant", textDelta: `token${i} ` };
      }
      yield { type: "finish", messageId: `answer-${streamId}`, finishReason: "stop" };
    } });
    const response = store.response({ streamId, ownerId: "fixture", signal: request.signal });
    if (request.headers.get("x-disconnect") === "true") {
      const reader = response.body!.getReader();
      let received = 0;
      return new Response(new ReadableStream({ async pull(controller) {
        const item = await reader.read();
        if (item.done) { controller.close(); return; }
        controller.enqueue(item.value);
        if (++received === 3) { await reader.cancel(); controller.close(); }
      }, cancel: () => reader.cancel() }), { headers: response.headers });
    }
    return response;
  }
  if (url.pathname === "/metrics") return Response.json({ runs, reconnects, toolExecutions, omniRequests, mediaTypes, audioFrames, interruptions });
  if (url.pathname === "/fixture.js" || url.pathname === "/fixture.css") return new Response(Bun.file(`.cache/react-browser${url.pathname}`));
  return new Response('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>', { headers: { "content-type": "text/html" } });
}, websocket: {
  open(socket) {
    const queue: AgentLiveEvent[] = []; let wake: (() => void) | undefined; let ended = false;
    const push = (event: AgentLiveEvent) => { queue.push(event); wake?.(); };
    const session = { config: { inputAudioMediaType: "audio/pcm", inputSampleRateHz: 16000, channels: 1 },
      sendAudio: async () => { audioFrames++; }, sendMedia: async () => {}, sendText: async () => {},
      interrupt: async () => { interruptions++; push({ type: "realtime-response-complete" }); },
      close: async () => { ended = true; wake?.(); },
      eventStream: async function* () {
        while (true) { const event = queue.shift(); if (event) yield event; else if (ended) return; else await new Promise<void>(resolve => { wake = resolve; }); }
      }
    } as unknown as RealtimeSession;
    socket.data.relay = createRealtimeRelay({ session, send: data => { socket.send(data); }, close: () => socket.close() });
    push({ type: "realtime-transcript", role: "assistant", itemId: "welcome", text: "Voice connected", isFinal: true });
    push({ type: "realtime-audio-output", audio: new Uint8Array(4800), mediaType: "audio/pcm", sampleRateHz: 24000, channels: 1 });
  },
  message(socket, message) { void socket.data.relay?.receive(String(message)); },
  close(socket) { void socket.data.relay?.close(); }
} });
console.log("React browser fixture: http://127.0.0.1:4178");
