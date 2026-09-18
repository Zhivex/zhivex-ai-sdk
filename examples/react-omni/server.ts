import { createQwen } from "@zhivex-ai/qwen";
import { createOmniRoutes } from "./routes.ts";
import { createRealtimeRelay } from "@zhivex-ai/react/realtime-server";
// A loopback development server. Production deployments must replace this local cookie with app authentication.
const port = 4179;
const origin = `http://127.0.0.1:${port}`;
const token = crypto.randomUUID();
const qwen = createQwen();
const routes = createOmniRoutes(qwen("qwen3.8-omni-flash"));
const build = await Bun.build({ entrypoints: ["examples/react-omni/client.tsx"], outdir: ".cache/react-omni", target: "browser" });
if (!build.success) throw new Error(build.logs.join("\n"));
let connections = 0;
const server = Bun.serve<{ relay?: ReturnType<typeof createRealtimeRelay>; closed?: boolean }>({ hostname: "127.0.0.1", port,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/client.css"></head><body><div id="root"></div><script type="module" src="/client.js"></script></body></html>', { headers: { "content-type": "text/html", "set-cookie": `omni-demo=${token}; HttpOnly; SameSite=Strict; Path=/` } });
    if (["/client.js", "/client.css"].includes(url.pathname)) return new Response(Bun.file(`.cache/react-omni${url.pathname}`));
    if (request.headers.get("cookie")?.split("; ").includes(`omni-demo=${token}`) !== true || (request.method !== "GET" || url.pathname === "/voice") && request.headers.get("origin") !== origin) return new Response("Unauthorized", { status: 401 });
    if (url.pathname === "/voice") {
      if (connections >= 2) return new Response("Voice capacity reached", { status: 503 });
      return server.upgrade(request, { data: {} }) ? undefined : new Response("Upgrade required", { status: 426 });
    }
    return routes.handle(request, "local-demo-user");
  }, websocket: {
    async open(socket) {
      connections++;
      try {
        const session = await qwen.realtimeModel(process.env.QWEN_REALTIME_MODEL ?? "qwen3.5-omni-flash-realtime").connect({ inputAudioMediaType: "audio/pcm", outputAudioMediaType: "audio/pcm", inputSampleRateHz: 16000, outputSampleRateHz: 24000, channels: 1, inputAudioTranscription: true });
        if (socket.data.closed) { await session.close(); return; }
        socket.data.relay = createRealtimeRelay({ session, send: data => { if (socket.send(data) <= 0) throw new Error("Voice socket backpressure."); }, close: () => socket.close() });
      } catch { socket.close(1011, "Voice connection failed"); }
    },
    message(socket, message) { if (typeof message !== "string" || !socket.data.relay) { socket.close(1008, "Invalid voice frame"); return; } void socket.data.relay.receive(message).catch(() => socket.close(1008)); },
    close(socket) { connections--; socket.data.closed = true; void socket.data.relay?.close(); }
  }
});
console.log(`Qwen Omni demo: ${origin}`);
process.on("SIGINT", () => { routes.dispose(); server.stop(true); process.exit(0); });
