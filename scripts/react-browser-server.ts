import { InMemoryChatReplayStore } from "../packages/react/src/replay.ts";
const output = await Bun.build({ entrypoints: ["packages/react/browser/fixture.tsx"], target: "browser", outdir: ".cache/react-browser", sourcemap: "inline" });
if (!output.success) throw new Error(output.logs.join("\n"));
const store = new InMemoryChatReplayStore({ maxStreams: 100 });
let runs = 0;
let reconnects = 0;
Bun.serve({ hostname: "127.0.0.1", port: 4178, async fetch(request) {
  const url = new URL(request.url);
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
  if (url.pathname === "/metrics") return Response.json({ runs, reconnects });
  if (url.pathname === "/fixture.js" || url.pathname === "/fixture.css") return new Response(Bun.file(`.cache/react-browser${url.pathname}`));
  return new Response('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>', { headers: { "content-type": "text/html" } });
} });
console.log("React browser fixture: http://127.0.0.1:4178");
