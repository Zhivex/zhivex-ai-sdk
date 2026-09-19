import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createVertex } from "../packages/vertex/src/index.js";
import { vertexIntegrationCredentials } from "../packages/core/tests/vertex-integration-profile.js";

// Explicit invocation creates one synthetic interaction and deletes it.
const modelId = process.env.VERTEX_INTERACTIONS_RESUME_MODEL;
const agent = process.env.VERTEX_INTERACTIONS_RESUME_AGENT;
if (Boolean(modelId) === Boolean(agent)) throw new Error("Set exactly one VERTEX_INTERACTIONS_RESUME_MODEL or VERTEX_INTERACTIONS_RESUME_AGENT with stored-stream support.");
const credentials = vertexIntegrationCredentials(process.env, true);
if (!credentials.configured) throw new Error(credentials.requirement);
const interactions = createVertex({ ...credentials.options, location: "global" }).interactions;
const omni = modelId === "gemini-omni-1.1-flash-preview";
const run = crypto.randomUUID();
const stateFile = `/tmp/vertex-interactions-resume-${run}.json`;
const state = { id: "", cursor: "", verified: false, cleaned: false, phase: "create", events: 0 };
const save = () => writeFile(stateFile, JSON.stringify(state));
try {
  const stream = await interactions.stream({ modelId, agent,
    input: omni ? [{ type: "user_input", content: [{ type: "text", text: "A stationary blue circle on a plain white background. No text or sound." }] }]
      : "For a synthetic API test, state the result of adding two and three in a brief response.",
    ...(omni ? { responseFormat: [{ type: "video", resolution: "360p", duration: "3s", aspect_ratio: "16:9" }],
      generationConfig: { video_config: { task: "text_to_video" } } } : {}),
    ...(omni ? { background: true } : {}), store: true, labels: { smoke: run }, timeoutMs: 60_000, maxRetries: 0 });
  for await (const event of stream) {
    if (event.type !== "provider-data" || !event.data || typeof event.data !== "object") continue;
    const data = event.data as Record<string, any>;
    state.events++;
    if (typeof data.interaction?.id === "string") state.id = data.interaction.id;
    if (typeof data.event_id === "string") state.cursor = data.event_id;
    await save();
    if (state.id && state.cursor) {
      assert.notEqual(data.event_type, "interaction.completed", "First cursor arrived only after completion; this does not prove mid-stream resumption");
      break;
    }
  }
  assert.ok(state.id && state.cursor, "Stream did not supply an interaction ID and resumable cursor");
  state.phase = "resume"; await save();
  let completed = false, nativeEvents = 0, attempts = 0;
  const deadline = Date.now() + 120_000;
  while (!completed && Date.now() < deadline && attempts++ < 30) {
    try {
      for await (const event of await interactions.resume({ id: state.id, lastEventId: state.cursor, timeoutMs: Math.min(30_000, deadline - Date.now()), maxRetries: 0 })) {
        if (event.type === "provider-data") {
          nativeEvents++;
          const data = event.data as Record<string, any>;
          if (typeof data?.event_id === "string") { state.cursor = data.event_id; await save(); }
        }
        if (event.type === "finish") { assert.equal(event.finishReason, "stop"); completed = true; }
      }
    } catch (error) {
      if ((error as Error).name !== "ConfigurationError" || !(error as Error).message.includes("without a terminal event")) throw error;
      // Background GET streams may drain available events before generation
      // finishes. Resume the same owned interaction from its latest cursor.
      const current = await interactions.get({ id: state.id, timeoutMs: 30_000, maxRetries: 0 });
      if (["failed", "cancelled", "incomplete"].includes(current.status ?? "")) throw new Error(`Stored interaction reached ${current.status}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  assert.ok(completed && nativeEvents > 0, "Resumed stream did not complete within its observation bound");
  const result = await interactions.get({ id: state.id, timeoutMs: 30_000, maxRetries: 0 });
  assert.equal(result.status, "completed");
  assert.ok(result.outputs?.length, "Completed interaction has no outputs");
  state.verified = true;
  console.log(JSON.stringify({ ok: true, scenario: "interactions-resume", nativeEvents, attempts }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, scenario: "interactions-resume", error: (error as Error).name, status: (error as {status?: number}).status, phase: state.phase, events: state.events, ...((error as Error).name === "ConfigurationError" ? {message:(error as Error).message} : {}) }));
  if (process.env.VERTEX_LIVE_DIAGNOSTICS === "1") {
    const body = (error as { responseBody?: unknown }).responseBody;
    let parsed: any = body;
    if (typeof body === "string") { try { parsed = JSON.parse(body); } catch { parsed = undefined; } }
    const message = parsed?.error?.message;
    if (typeof message === "string") console.log(JSON.stringify({ diagnostic: message.replaceAll(credentials.options.projectId ?? "__no_project__", "[project]").slice(0, 512) }));
  }
  process.exitCode = 1;
} finally {
  if (state.id) {
    try {
      // A transport close can take time to settle server-side. Retry only this
      // owned interaction, never create a replacement after an uncertain result.
      for (let attempt = 0; ; attempt++) {
        try { await interactions.delete({ id: state.id, timeoutMs: 30_000, maxRetries: 0 }); break; }
        catch (error) {
          if (attempt >= 3 || ![400, 409].includes((error as {status?:number}).status ?? 0)) throw error;
          const current = await interactions.get({ id: state.id, timeoutMs: 30_000, maxRetries: 0 });
          if (attempt === 0 && ["in_progress", "queued"].includes(current.status ?? "")) {
            await interactions.cancel({ id: state.id, timeoutMs: 30_000, maxRetries: 0 });
          }
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        }
      }
      try { await interactions.get({ id: state.id, timeoutMs: 30_000, maxRetries: 0 }); }
      catch (error) {
        if ((error as {status?: number}).status === 404) state.cleaned = true;
        else throw error;
      }
      assert.ok(state.cleaned, "Interaction remains after deletion");
    } catch (error) {
      console.log(JSON.stringify({ ok: false, scenario: "cleanup", error: (error as Error).name, status: (error as {status?: number}).status }));
      process.exitCode = 1;
    }
  }
  await save();
  console.log(JSON.stringify({ stateFile, verified: state.verified, cleaned: state.cleaned, interactionObserved: Boolean(state.id) }));
}
