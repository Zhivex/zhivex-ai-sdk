import { Agent, createRunner, createInMemorySessionService, createInMemoryAgentRunStore, toUIMessageStream, tool,
  type LanguageModel, type ContentPart, type AgentApprovalResponse } from "@zhivex-ai/sdk";
import { InMemoryChatReplayStore, ChatReplayError } from "../../packages/react/src/replay.js";
import { z } from "zod";

/** Development upload storage. Replace with owner-scoped object storage in production. */
export function createOmniRoutes(model: LanguageModel, onTool?: () => void) {
  const uploads = new Map<string, { owner: string; bytes: Uint8Array; mediaType: string; filename: string; expires: number }>();
  const replay = new InMemoryChatReplayStore({ maxRunMs: 180_000 });
  const runner = createRunner({ appName: "react-omni", sessionService: createInMemorySessionService(), agent: new Agent({
    id: "omni-assistant", name: "Omni assistant", model, store: createInMemoryAgentRunStore(),
    instructions: "Describe the supplied media. Use lookup_media_context when asked to consult context; ask approval through the tool. Never invent media contents.",
    maxSteps: 4, reasoning: { effort: "none" }, policy: { maxStateBytes: 64 * 1024 * 1024, timeoutMs: 150_000, budget: { maxTotalTokens: 16000, maxToolCalls: 4 } },
    tools: { lookup_media_context: tool({ name: "lookup_media_context", description: "Read the application's demo media context", schema: z.object({}), requiresApproval: true, approvalMode: "interrupt", execute: async () => { onTool?.(); return { context: "User-provided media for analysis; no automatic publication." }; } }) }
  }) });
  const read = async (request: Request, limit: number) => {
    const reader = request.body?.getReader(); if (!reader) return new Uint8Array();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) { const item = await reader.read(); if (item.done) break; size += item.value.length;
        if (size > limit) { await reader.cancel(); throw new Error("Request too large."); } chunks.push(item.value); }
    } finally { reader.releaseLock(); }
    const result = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result;
  };
  return { dispose: () => replay.dispose(), async handle(request: Request, owner: string): Promise<Response> {
    if (!owner) return new Response("Unauthorized", { status: 401 });
    const url = new URL(request.url);
    try {
      if (url.pathname === "/omni/uploads" && request.method === "POST") {
        for (const [id, upload] of uploads) if (upload.expires < Date.now()) uploads.delete(id);
        const mediaType = request.headers.get("content-type")?.split(";")[0] ?? "";
        if (!/^(image|audio|video)\/[a-z0-9.+-]+$/i.test(mediaType)) return new Response("Unsupported media", { status: 415 });
        const bytes = await read(request, 8 * 1024 * 1024);
        if ([...uploads.values()].reduce((size, upload) => size + upload.bytes.length, 0) + bytes.length > 32 * 1024 * 1024) return new Response("Upload capacity reached", { status: 503 });
        const id = crypto.randomUUID();
        const filename = decodeURIComponent(request.headers.get("x-filename") ?? "media").slice(0, 200);
        uploads.set(id, { owner, bytes, mediaType, filename, expires: Date.now() + 600_000 });
        return Response.json({ reference: `${url.origin}/omni/uploads/${id}` });
      }
      if (url.pathname.startsWith("/omni/uploads/") && request.method === "GET") {
        const upload = uploads.get(url.pathname.slice("/omni/uploads/".length));
        if (!upload || upload.owner !== owner || upload.expires < Date.now()) return new Response("Not found", { status: 404 });
        return new Response(new Uint8Array(upload.bytes), { headers: { "content-type": upload.mediaType, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" } });
      }
      if (url.pathname !== "/omni") return new Response("Not found", { status: 404 });
      if (request.method === "GET") return replay.response({ streamId: url.searchParams.get("streamId") ?? "", after: Number(url.searchParams.get("after") ?? 0), ownerId: owner, signal: request.signal });
      if (request.method === "DELETE") { replay.cancel(url.searchParams.get("streamId") ?? "", owner); return new Response(null, { status: 204 }); }
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      const body = JSON.parse(new TextDecoder().decode(await read(request, 64 * 1024)));
      let parts: ContentPart[] | undefined;
      if (body.message) {
        if (body.message.role !== "user" || !Array.isArray(body.message.parts) || body.message.parts.length > 8) throw new Error("Invalid user message.");
        parts = body.message.parts.map((part: Record<string, unknown>): ContentPart => {
          if (part.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
          if (!["image", "audio", "file"].includes(String(part.type))) throw new Error("Invalid media type.");
          const reference = part.type === "image" ? part.image : part.data;
          if (typeof reference !== "string" || !reference.startsWith(`${url.origin}/omni/uploads/`)) throw new Error("Upload media first.");
          const upload = uploads.get(reference.slice(`${url.origin}/omni/uploads/`.length));
          if (!upload || upload.owner !== owner || upload.expires < Date.now()) throw new Error("Upload expired or not owned.");
          const data = `data:${upload.mediaType};base64,${Buffer.from(upload.bytes).toString("base64")}`;
          if (upload.mediaType.startsWith("image/")) return { type: "image", image: data, mediaType: upload.mediaType };
          if (upload.mediaType.startsWith("audio/")) return { type: "audio", data, mediaType: upload.mediaType, filename: upload.filename };
          return { type: "file", data, mediaType: upload.mediaType, filename: upload.filename };
        });
      }
      const approvals: AgentApprovalResponse[] | undefined = body.approvals === undefined ? undefined : z.array(z.object({ provider: z.string(), approvalRequestId: z.string(), approve: z.boolean(), reason: z.string().optional() })).max(8).parse(body.approvals);
      if (!parts?.length && !approvals?.length) throw new Error("Missing message or approval.");
      const sessionId = body.sessionId === undefined ? undefined : z.string().max(200).parse(body.sessionId);
      const streamId = replay.create({ ownerId: owner, source: async function* (signal) {
        const stream = runner.stream({ userId: owner, sessionId, messages: parts ? [{ role: "user", parts }] : undefined, approvals, abortSignal: signal });
        try { yield* toUIMessageStream(stream.eventStream, { includeAgentRunFinish: false }); }
        catch (error) { await stream.collect().catch(() => {}); throw error; }
        const result = await stream.collect();
        yield { type: "session-finish", sessionId: result.session.sessionId, status: result.output.status };
      } });
      return replay.response({ streamId, ownerId: owner, signal: request.signal });
    } catch (error) {
      return Response.json({ error: error instanceof ChatReplayError ? error.message : "Invalid request or media." }, { status: error instanceof ChatReplayError ? error.status : 400 });
    }
  } };
}
