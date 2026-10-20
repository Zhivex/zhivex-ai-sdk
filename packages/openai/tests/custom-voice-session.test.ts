import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { RealtimeConnection } from "@zhivex-ai/core";
import { createOpenAI } from "../src/index.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../../..");

class LiveConnection implements RealtimeConnection {
  sent: Record<string, unknown>[] = [];
  queue: unknown[] = [];
  waiter?: (value: unknown) => void;
  closed = false;
  push(value: unknown) {
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve(value);
    } else this.queue.push(value);
  }
  async sendJson(payload: Record<string, unknown>) {
    this.sent.push(payload);
    if (payload.type === "session.start") this.push({ type: "session.started", session: { id: "live_123" } });
    if (payload.type === "session.close") this.push({ type: "session.closed", usage: { duration_seconds: 1 } });
  }
  async recvJson() {
    return this.queue.length ? this.queue.shift() : this.closed ? undefined : new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
  async close() {
    this.closed = true;
    this.push(undefined);
  }
}

const voiceOf = (payload: Record<string, unknown> | undefined) =>
  (payload?.session as { audio?: { output?: { voice?: unknown } } } | undefined)?.audio?.output?.voice;

describe("OpenAI custom voice sessions", () => {
  it("keeps a custom voice on Realtime connect and serializes it again on update", async () => {
    const sent: Record<string, unknown>[] = [];
    let finishReceive: (() => void) | undefined;
    const receive = new Promise<undefined>((resolve) => {
      finishReceive = () => resolve(undefined);
    });
    const connectionFactory = vi.fn(async () => ({
      async sendJson(payload: Record<string, unknown>) {
        sent.push(payload);
      },
      async recvJson() {
        return receive;
      },
      async close() {
        finishReceive?.();
      }
    }));
    const provider = createOpenAI({ apiKey: "test", realtimeConnectionFactory: connectionFactory });
    const initial = { id: "voice_123" };
    const session = await provider.realtimeModel!("gpt-realtime").connect({ voice: initial });
    expect(session.config.voice).toBe(initial);
    expect(voiceOf(sent[0])).toBe(initial);
    expect(JSON.stringify(sent[0])).toContain('"voice":{"id":"voice_123"}');

    const next = { id: "voice_456" };
    await session.update({ voice: next });
    expect(session.config.voice).toEqual(next);
    expect(sent.filter((payload) => payload.type === "session.update")).toHaveLength(2);
    expect(voiceOf(sent[1])).toEqual(next);
    expect(JSON.stringify(sent[1])).toContain('"voice":{"id":"voice_456"}');
    await session.close();
  });

  it("keeps a custom voice on GPT-Live connect and accepts it in update", async () => {
    const connection = new LiveConnection();
    const provider = createOpenAI({
      apiKey: "test",
      realtimeConnectionFactory: async () => connection
    });
    const initial = { id: "voice_123" };
    const session = await provider.realtimeModel!("gpt-live-1").connect({ voice: initial });
    expect(session.config.voice).toBe(initial);
    expect(connection.sent[0]?.type).toBe("session.start");
    expect(voiceOf(connection.sent[0])).toBe(initial);
    expect(JSON.stringify(connection.sent[0])).toContain('"voice":{"id":"voice_123"}');

    const next = { id: "voice_456" };
    await expect(session.update({ voice: next })).rejects.toThrow(/immutable/);
    expect(session.config.voice).toBe(initial);
    expect(connection.sent).toHaveLength(1);
    await session.close();
  });

  it("typechecks custom-voice sessions without widening the shared voice", async () => {
    const tsc = path.join(repoRoot, "node_modules", ".bin", "tsc");
    const project = path.join(repoRoot, "packages/openai/tests/fixtures/openai-voice-session-types/tsconfig.json");
    await expect(execFileAsync(tsc, ["--project", project], { cwd: repoRoot })).resolves.toMatchObject({
      stdout: "",
      stderr: ""
    });
  }, 30_000);
});
