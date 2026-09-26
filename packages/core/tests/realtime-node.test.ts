import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { openWebSocketConnection } from "../src/realtime.js";
import { openAuthenticatedWebSocketConnection as browserConnection } from "../src/realtime-browser.js";

const start = async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  return { server, url: `ws://127.0.0.1:${address.port}`, close: async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
};
describe("authenticated runtime WebSocket transport", () => {
  it("preserves abnormal server close codes and reasons for pending readers", async () => {
    const fixture = await start();
    fixture.server.on("connection", socket => socket.on("message", () => socket.close(1008, "model access denied")));
    try {
      const connection = await openWebSocketConnection(fixture.url, { authorization: "Bearer synthetic" });
      await connection.sendJson({ setup: {} });
      await expect(connection.recvJson()).rejects.toThrow("1008: model access denied");
      await connection.close();
    } finally { await fixture.close(); }
  });
  it("sends auth headers and rejects pending receive on cancellation", async () => {
    const fixture = await start();
    const controller = new AbortController();
    let authorization: string | undefined;
    fixture.server.on("connection", (socket, req) => { authorization = req.headers.authorization; socket.on("message", () => socket.send(JSON.stringify({ ok: true }))); });
    try {
      const connection = await openWebSocketConnection(fixture.url, { authorization: "Bearer synthetic" }, { signal: controller.signal, timeoutMs: 1000 });
      await connection.sendJson({ hello: true });
      expect(await connection.recvJson()).toEqual({ ok: true });
      expect(authorization).toBe("Bearer synthetic");
      const pending = connection.recvJson();
      const rejection = expect(pending).rejects.toThrow("cancel test");
      controller.abort(new Error("cancel test"));
      await rejection;
      await connection.close();
    } finally { await fixture.close(); }
  });
  it("times out stalled upgrades without unhandled socket errors", async () => {
    const server = createServer();
    const sockets = new Set<import("node:net").Socket>();
    server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    server.on("upgrade", () => {});
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as import("node:net").AddressInfo;
    try {
      await expect(openWebSocketConnection(`ws://127.0.0.1:${address.port}`, { authorization: "Bearer synthetic" }, { timeoutMs: 30 })).rejects.toThrow("timed out");
    } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("preserves binary frames alongside JSON without changing recvJson semantics", async () => {
    const fixture = await start();
    fixture.server.on("connection", socket => socket.on("message", (data, binary) => {
      socket.send(JSON.stringify({ binary }));
      socket.send(data, { binary: true });
    }));
    try {
      const connection = await openWebSocketConnection(fixture.url, { authorization: "Bearer synthetic" });
      await connection.sendBinary!(new Uint8Array([0, 255, 1, 128]));
      expect(await connection.recvFrame!()).toEqual({ binary: true });
      expect(await connection.recvFrame!()).toEqual(new Uint8Array([0, 255, 1, 128]));
      await connection.sendJson({ hello: true });
      expect(await connection.recvJson()).toEqual({ binary: false });
      await expect(connection.recvJson()).rejects.toThrow("received binary data");
      await connection.close();
    } finally { await fixture.close(); }
  });
  it("bounds cumulative binary queue bytes before the message count limit", async () => {
    const fixture = await start();
    fixture.server.on("connection", socket => socket.on("message", () => {
      const frame = Buffer.alloc(1024 * 1024);
      for (let index = 0; index < 33; index++) socket.send(frame, { binary: true });
    }));
    try {
      const connection = await openWebSocketConnection(fixture.url, { authorization: "Bearer synthetic" });
      await connection.sendJson({ start: true });
      await new Promise(resolve => setTimeout(resolve, 150));
      await expect(connection.recvFrame!()).rejects.toThrow("receive buffer exceeded");
      await connection.close();
    } finally { await fixture.close(); }
  });
  it("keeps bearer-header sessions unsupported in browsers", async () => {
    await expect(browserConnection("wss://example.test", { authorization: "Bearer synthetic" })).rejects.toThrow("Browser WebSocket");
  });
});
