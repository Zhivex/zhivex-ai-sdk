import WebSocket from "ws";
import type { RealtimeConnectionFactory } from "../../packages/core/src/index.js";

/** Bounded server transport for opt-in live smoke scripts. */
export function createLiveSmokeTransport() {
const sockets: WebSocket[] = [];
const factory: RealtimeConnectionFactory = async (url, headers, options) => {
  const ws = new WebSocket(url, { headers, maxPayload: 16 * 1024 * 1024, handshakeTimeout: options?.timeoutMs ?? 15000, followRedirects: false });
  sockets.push(ws);
  const queue: unknown[] = [];
  let waiter: ((x: unknown) => void) | undefined;
  let failure: Error | undefined;
  let closed = false;
  const push = (value: unknown) => {
    if (waiter) { const resolve = waiter; waiter = undefined; resolve(value); }
    else if (queue.length < 256) queue.push(value);
    else { failure = new Error("Incoming queue overflow"); ws.terminate(); }
  };
  ws.on("message", (data) => {
    try { push(JSON.parse(data.toString())); } catch { failure = new Error("Invalid JSON frame"); ws.terminate(); }
  });
  ws.on("error", (error) => { failure = error; push(undefined); });
  ws.on("close", (code) => { closed = true; if (code !== 1000 && !failure) failure = new Error(`WebSocket closed: ${code}`); push(undefined); });
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return {
    async sendJson(value) { await new Promise<void>((resolve, reject) => ws.send(JSON.stringify(value), (error) => error ? reject(error) : resolve())); },
    async recvJson() {
      if (failure) throw failure;
      const value = queue.length ? queue.shift() : closed ? undefined : await new Promise((resolve) => { waiter = resolve; });
      if (failure) throw failure;
      return value;
    },
    async close() {
      if (ws.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { ws.terminate(); resolve(); }, 1000);
        ws.once("close", () => { clearTimeout(timer); resolve(); });
        ws.close();
      });
    }
  };
};

return { factory, terminate: () => { for (const socket of sockets) if (socket.readyState !== WebSocket.CLOSED) socket.terminate(); } };
}
