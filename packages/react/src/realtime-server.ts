import type { AgentLiveEvent, AudioFrame, RealtimeSession } from "@zhivex-ai/core";
import { decodeRealtimeBase64, encodeRealtimeEvent, MAX_REALTIME_FRAME_CHARS } from "./realtime-codec.js";

export interface RealtimeRelayOptions {
  /** Create only after validating the WebSocket upgrade's user, tenant, and Origin. */
  session: RealtimeSession;
  /** streamLiveAgent().eventStream includes server-executed tools and approvals. */
  events?: AsyncIterable<AgentLiveEvent>;
  send: (data: string) => void | Promise<void>;
  close: () => void;
  maxSessionMs?: number;
  /** Optional provider-specific interruption when the session does not implement it. */
  interrupt?: () => Promise<void>;
}

/** Socket-independent relay. No browser command can execute tools or change model/policy. */
export function createRealtimeRelay(options: RealtimeRelayOptions) {
  const lifetime = options.maxSessionMs ?? 30 * 60_000;
  if (!Number.isSafeInteger(lifetime) || lifetime <= 0) throw new RangeError("Invalid realtime session lifetime.");
  let stopped = false;
  let pending = 0;
  let chain = Promise.resolve();
  const send = async (value: unknown) => {
    const data = JSON.stringify(value);
    if (data.length > MAX_REALTIME_FRAME_CHARS) throw new Error("Realtime relay output frame too large.");
    if (!stopped) await options.send(data);
  };
  const close = async () => {
    if (stopped) return;
    stopped = true; clearTimeout(timer);
    // A provider close failure must not leave the client socket or timer alive.
    try { await options.session.close(); } catch { /* Session is already terminating. */ }
    finally { options.close(); }
  };
  const timer = setTimeout(() => { void close(); }, lifetime);
  const done = (async () => {
    try {
      await send({ type: "ready" });
      for await (const event of options.events ?? options.session.eventStream()) {
        if (stopped) break;
        // Keep full agent state and provider data on the server.
        if (!["realtime-start", "realtime-end", "realtime-error", "error", "realtime-text-delta", "realtime-transcript", "realtime-audio-output", "realtime-response-complete", "realtime-delegation", "agent-run-update"].includes(event.type)) continue;
        await send({ type: "event", event: encodeRealtimeEvent(event) });
      }
    } catch { await send({ type: "event", event: { type: "realtime-error", message: "Realtime relay failed." } }).catch(() => {}); }
    finally { await close(); }
  })();
  const receive = (data: string): Promise<void> => {
    if (stopped) return Promise.reject(new Error("Realtime relay is closed."));
    if (typeof data !== "string" || data.length > MAX_REALTIME_FRAME_CHARS || ++pending > 32) { void close(); return Promise.reject(new Error("Realtime command limit exceeded.")); }
    const work = chain.then(async () => {
      if (stopped) return;
      const command = JSON.parse(data);
      if (!Number.isSafeInteger(command.id) || command.id <= 0) throw new Error("Invalid command identity.");
      try {
        if (command.type === "text" && typeof command.payload === "string" && command.payload.length <= 32768) await options.session.sendText(command.payload);
        else if (command.type === "interrupt") {
          const interrupt = options.interrupt ?? options.session.interrupt?.bind(options.session);
          if (!interrupt) throw new Error("Interruption is unsupported.");
          await interrupt();
        } else if (command.type === "audio" || command.type === "media") {
          const value = command.payload;
          if (!value || typeof value.data !== "string" || typeof value.mediaType !== "string") throw new Error("Invalid media frame.");
          const frame: AudioFrame = { data: decodeRealtimeBase64(value.data), mediaType: value.mediaType };
          if (command.type === "audio") {
            // The server, not browser input, owns the provider's media configuration.
            const config = options.session.config;
            if (value.mediaType !== (config.inputAudioMediaType ?? "audio/pcm") || value.sampleRateHz !== (config.inputSampleRateHz ?? 16000) || value.channels !== (config.channels ?? 1)) throw new Error("Audio configuration mismatch.");
            frame.sampleRateHz = value.sampleRateHz; frame.channels = value.channels;
            await options.session.sendAudio(frame);
          } else await options.session.sendMedia(frame);
        } else throw new Error("Unsupported realtime command.");
        await send({ type: "ack", id: command.id });
      } catch { await send({ type: "ack", id: command.id, error: "Realtime command failed or is unsupported." }); }
    }).catch(async () => { await close(); }).finally(() => { pending--; });
    chain = work;
    return work;
  };
  return { receive, close, done };
}
