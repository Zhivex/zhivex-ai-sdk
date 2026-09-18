"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentLiveEvent, AudioFrame, MediaFrame } from "@zhivex-ai/core";
import { createBrowserRealtimeAudio, type RealtimeAudioDriver } from "./realtime-audio.js";
export { createBrowserRealtimeAudio, REALTIME_CAPTURE_WORKLET_SOURCE } from "./realtime-audio.js";
export type { RealtimeAudioDriver } from "./realtime-audio.js";
export { createWebSocketRealtimeTransport } from "./realtime-transport.js";
export type { WebSocketRealtimeTransportOptions } from "./realtime-transport.js";

export interface RealtimeChatSession {
  events: AsyncIterable<AgentLiveEvent>;
  sendText(text: string): Promise<void>;
  sendAudio(frame: AudioFrame): Promise<void>;
  sendMedia(frame: MediaFrame): Promise<void>;
  interrupt?(): Promise<void>;
  close(): Promise<void>;
}
export interface RealtimeChatTransport {
  connect(options: { signal: AbortSignal }): Promise<RealtimeChatSession>;
}
export interface RealtimeTranscript {
  id: string;
  role: "user" | "assistant";
  text: string;
  final: boolean;
}
export interface UseZhivexRealtimeOptions {
  transport: RealtimeChatTransport;
  createAudio?: () => RealtimeAudioDriver;
  maxTranscripts?: number;
  maxTranscriptChars?: number;
  onEvent?: (event: AgentLiveEvent) => void;
  onError?: (error: Error) => void;
}

interface ActiveRealtimeConnection { abort: AbortController; audio: RealtimeAudioDriver; session?: RealtimeChatSession; micPending?: boolean; micVersion?: number; interrupted?: boolean; responseActive?: boolean }

export function useZhivexRealtime(options: UseZhivexRealtimeOptions) {
  const [status, setStatus] = useState<"disconnected" | "connecting" | "connected" | "error">("disconnected");
  const [error, setError] = useState<Error>();
  const [microphoneActive, setMicrophoneActive] = useState(false);
  const [transcripts, setTranscripts] = useState<RealtimeTranscript[]>([]);
  const settings = useRef(options); settings.current = options;
  const mounted = useRef(true);
  const active = useRef<ActiveRealtimeConnection | undefined>(undefined);
  const disconnect = useCallback(async () => {
    const connection = active.current; active.current = undefined;
    connection?.abort.abort();
    if (mounted.current) { setMicrophoneActive(false); setStatus("disconnected"); }
    if (connection) await Promise.allSettled([connection.audio.close(), connection.session?.close()]);
  }, []);
  const report = useCallback((cause: unknown) => {
    const failure = cause instanceof Error ? cause : new Error(String(cause));
    if (mounted.current) { setError(failure); setStatus("error"); }
    settings.current.onError?.(failure);
  }, []);
  const connect = useCallback(async () => {
    if (active.current) return;
    const connection: ActiveRealtimeConnection = { abort: new AbortController(), audio: (settings.current.createAudio ?? createBrowserRealtimeAudio)() };
    active.current = connection;
    setError(undefined); setTranscripts([]); setStatus("connecting");
    const current = () => mounted.current && active.current === connection;
    try {
      // Unlock output synchronously with the click, before connecting to the server.
      await connection.audio.start();
      if (!current()) return;
      const session = await settings.current.transport.connect({ signal: connection.abort.signal });
      if (!current()) { await session.close(); return; }
      connection.session = session; setStatus("connected");
      void (async () => {
        let turn = 0;
        const spokenItems = new Set<string>();
        try {
          for await (const event of session.events) {
            if (!current()) break;
            if (event.type === "realtime-error") throw event.error ?? new Error(event.message ?? "Realtime session failed.");
            if (event.type === "realtime-end") break;
            if (event.type === "realtime-response-complete") { connection.interrupted = false; connection.responseActive = false; turn++; }
            if (event.type === "realtime-audio-output" || event.type === "realtime-text-delta" || event.type === "realtime-transcript" && event.role === "assistant" && !event.isFinal) connection.responseActive = true;
            if (event.type === "realtime-audio-output" && !connection.interrupted) connection.audio.play(event);
            if (event.type === "realtime-transcript" || event.type === "realtime-text-delta") {
              const role = event.type === "realtime-text-delta" ? "assistant" : event.role;
              const id = `${role}:${event.itemId ?? event.responseId ?? turn}`;
              const isTranscript = event.type === "realtime-transcript";
              const hadTranscript = spokenItems.has(id);
              if (isTranscript) {
                spokenItems.add(id);
                if (spokenItems.size > 1000) spokenItems.delete(spokenItems.values().next().value!);
              }
              const text = event.type === "realtime-text-delta" ? event.textDelta : event.text;
              const final = event.type === "realtime-transcript" && event.isFinal;
              const limit = Math.min(1000, Math.max(1, Math.floor(settings.current.maxTranscripts ?? 100) || 100));
              const chars = Math.min(1_000_000, Math.max(1, Math.floor(settings.current.maxTranscriptChars ?? 16_384) || 16_384));
              if (isTranscript || !hadTranscript) setTranscripts(previous => {
                const old = previous.find(item => item.id === id);
                const next = { id, role, final, text: (final ? text : (isTranscript && !hadTranscript ? "" : old?.text ?? "") + text).slice(-chars) };
                return [...previous.filter(item => item.id !== id), next].slice(-limit);
              });
            }
            settings.current.onEvent?.(event);
          }
          if (current()) await disconnect();
        } catch (cause) { if (current()) { await disconnect(); if (!active.current && mounted.current) report(cause); } }
      })();
    } catch (cause) { if (current()) { await disconnect(); if (!active.current && mounted.current) report(cause); } }
  }, [disconnect, report]);
  const startMicrophone = useCallback(async () => {
    const connection = active.current;
    if (!connection?.session) throw new Error("Connect before starting the microphone.");
    if (connection.micPending) return;
    connection.micPending = true;
    const version = (connection.micVersion ?? 0) + 1;
    connection.micVersion = version;
    const current = () => active.current === connection && connection.micVersion === version;
    const micError = (cause: unknown) => {
      if (!current()) return;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      setMicrophoneActive(false); setError(error); settings.current.onError?.(error);
    };
    try {
      await connection.audio.startMicrophone(frame => connection.session!.sendAudio(frame), micError);
      if (current() && connection.micPending) { setError(undefined); setMicrophoneActive(true); }
    } catch (cause) { micError(cause); }
    finally { if (current()) connection.micPending = false; }
  }, []);
  const stopMicrophone = useCallback(() => {
    if (active.current) { active.current.micVersion = (active.current.micVersion ?? 0) + 1; active.current.micPending = false; active.current.audio.stopMicrophone(); }
    setMicrophoneActive(false);
  }, []);
  const interrupt = useCallback(async () => {
    const connection = active.current;
    if (!connection?.session?.interrupt) throw new Error("This realtime transport does not support interruption.");
    connection.audio.interrupt();
    // Completed inference may still have queued local playback. Do not send a
    // provider cancellation for that case: Qwen rejects cancellation while idle.
    if (!connection.responseActive) return;
    connection.interrupted = true;
    try { await connection.session.interrupt(); }
    catch (error) { connection.interrupted = false; throw error; }
  }, []);
  const sendText = useCallback(async (text: string) => {
    if (!active.current?.session) throw new Error("Realtime session is not connected.");
    const connection = active.current;
    connection.responseActive = true;
    try { await connection.session!.sendText(text); }
    catch (error) { connection.responseActive = false; throw error; }
  }, []);
  const sendMedia = useCallback(async (frame: MediaFrame) => {
    if (!active.current?.session) throw new Error("Realtime session is not connected.");
    await active.current.session.sendMedia(frame);
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; void disconnect(); }; }, [disconnect]);
  return { status, error, microphoneActive, transcripts, connect, disconnect, startMicrophone, stopMicrophone, interrupt, sendText, sendMedia };
}
export type UseZhivexRealtimeResult = ReturnType<typeof useZhivexRealtime>;
