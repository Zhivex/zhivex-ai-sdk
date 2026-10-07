import { experimentalCreateOpenAILiveWebRTCSession, experimentalAttachOpenAILiveSession } from "@zhivex-ai/openai/experimental/live-server";
import { runRealtimeDelegations, type RealtimeDelegationContext } from "@zhivex-ai/core/realtime";

type Sideband = Awaited<ReturnType<typeof experimentalAttachOpenAILiveSession>>;
export interface VoiceApp {
  /** Exact configured origin, e.g. http://localhost:3000. Never derive it from Host. */
  origin: string;
  /** Authenticate and atomically consume a server-issued creation lease; reject duplicates.
   * Enforce owner, quotas/concurrency, expiry and payload limits before any paid request. */
  claimCreation(request: Request): Promise<{ leaseId: string; safetyIdentifier: string }>;
  /** Bind even if the caller disconnects. Retain an orphan watchdog that closes via sideband. */
  bindSession(leaseId: string, sessionId: string): Promise<void>;
  authorizeSession(request: Request, sessionId: string): Promise<void>;
  /** Hand off to a long-lived backend worker, attaching before returning the SDP answer.
   * Worker saves usage, closes expired/orphan sessions and removes finalized sessions. */
  retainWorker(sessionId: string, sideband: Sideband, task: Promise<void>): void;
  sessionOwner(sessionId: string): Promise<Sideband>;
  /** Existing Luna/tool backend: review results and task revisions before sendUpdate. */
  onDelegation(context: RealtimeDelegationContext): Promise<void>;
}
/** Next.js Node route recipe: export const { POST, DELETE } = createVoiceRoutes(app).
 * app implements your existing auth/session store and worker, not a new public service. */
export function createVoiceRoutes(app: VoiceApp) {
  const authorizedOrigin = (request: Request) => request.headers.get("origin") === app.origin;
  return {
    async POST(request: Request): Promise<Response> {
      if (!authorizedOrigin(request)) return new Response(null, { status: 403 });
      const lease = await app.claimCreation(request);
      // Bound the request even when Content-Length is absent or misleading.
      const reader = request.body?.getReader();
      if (!reader) return new Response(null, { status: 400 });
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) { const result = await reader.read(); if (result.done) break; size += result.value.length;
          if (size > 96 * 1024) { await reader.cancel(); return new Response(null, { status: 413 }); } chunks.push(result.value); }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const { sdp } = JSON.parse(new TextDecoder().decode(bytes));
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return new Response("Set OPENAI_API_KEY on the server", { status: 503 });
      try {
        const answer = await experimentalCreateOpenAILiveWebRTCSession({ apiKey, offerSdp: sdp,
          safetyIdentifier: lease.safetyIdentifier, signal: request.signal,
          session: { instructions: "Speak concisely. Delegate application tasks to the backend." },
          onSessionCreated: async ({ sessionId }) => {
            await app.bindSession(lease.leaseId, sessionId);
            // Separate signal: request cancellation must not detach the backend worker.
            const sideband = await experimentalAttachOpenAILiveSession({ apiKey, sessionId, safetyIdentifier: lease.safetyIdentifier });
            const task = runRealtimeDelegations(sideband, { onDelegation: app.onDelegation });
            app.retainWorker(sessionId, sideband, task);
            // Worker owns terminal usage capture, failure reconciliation and watchdog deadlines.
            void task.catch(() => sideband.close().catch(() => undefined));
            if (request.signal.aborted) await sideband.close();
          }
        });
        return Response.json(answer, { status: 201, headers: { "cache-control": "no-store" } });
      } catch { return new Response("Voice connection failed; backend will reconcile the creation lease.", { status: 502 }); }
    },
    async DELETE(request: Request): Promise<Response> {
      if (!authorizedOrigin(request)) return new Response(null, { status: 403 });
      // Use the same bounded JSON parser as POST in your route middleware (max 1 KiB here).
      const raw = await request.text(); if (new TextEncoder().encode(raw).length > 1024) return new Response(null, { status: 413 });
      const { sessionId } = JSON.parse(raw);
      await app.authorizeSession(request, sessionId);
      await (await app.sessionOwner(sessionId)).close();
      return new Response(null, { status: 204 });
    }
  };
}
