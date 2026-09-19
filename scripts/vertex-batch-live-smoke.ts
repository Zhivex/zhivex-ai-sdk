import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createVertex } from "../packages/vertex/src/index.js";

// Explicit live resource operations. State contains resource IDs, never credentials.
// start creates one private temporary bucket and one single-request Gemini/Claude job.
// status observes the same job; cleanup refuses to delete a nonterminal job.
const [mode, statePath, ...flags] = process.argv.slice(2);
if (flags.some(flag => flag !== "--claude") || (flags.length && mode !== "start")) throw new Error("--claude is supported only when starting a job.");
if (!["start", "status", "cancel", "cleanup", "verify-cleanup"].includes(mode) || !statePath) {
  throw new Error("Usage: bun run scripts/vertex-batch-live-smoke.ts start|status|cancel|cleanup|verify-cleanup /absolute/state.json [--claude (start only)]");
}
const { GoogleAuth } = createRequire(new URL("../packages/vertex/package.json", import.meta.url))("google-auth-library");
const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
type State = { version: 1; project: string; location: string; bucket: string; marker: string; model?: string; job?: string; state?: string; verified?: boolean; bucketCreated?: boolean; cleaned?: boolean; deleteOperation?: string; cancelRequested?: boolean; cancellationVerified?: boolean };
let state: State;
if (mode === "start") {
  const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
  if (!project) throw new Error("A Google Cloud project is required.");
  state = { version: 1, project, location: flags.includes("--claude") ? "us-east5" : "us-central1", bucket: `zhx-vertex-smoke-${randomUUID().replaceAll("-", "")}`, marker: "vertex-batch-smoke-ok", model: flags.includes("--claude") ? "claude-sonnet-4-6" : "gemini-2.5-flash" };
  writeFileSync(statePath, JSON.stringify(state, null, 2), { flag: "wx", mode: 0o600 });
} else state = JSON.parse(readFileSync(statePath, "utf8"));
if (state.version !== 1 || !/^zhx-vertex-smoke-[a-f0-9]{32}$/.test(state.bucket) || !["us-central1", "us-east5"].includes(state.location)) throw new Error("Invalid smoke resource ownership state.");
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
const model = state.model ?? "gemini-2.5-flash";
if (!["gemini-2.5-flash", "claude-sonnet-4-6"].includes(model)) throw new Error("Unsupported smoke model.");
const http = async (url: string, method = "GET", body?: unknown, media = false): Promise<any> => {
  const token = await auth.getAccessToken();
  if (!token) throw new Error("ADC did not return a token.");
  const response = await fetch(url, { method, redirect: "error", signal: AbortSignal.timeout(30_000), headers: {
    authorization: `Bearer ${token}`, "content-type": media ? "application/jsonl" : "application/json"
  }, ...(body === undefined ? {} : { body: media ? String(body) : JSON.stringify(body) }) });
  if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`Cloud resource request failed: HTTP ${response.status}`), { status: response.status }); }
  if (response.status === 204) return undefined;
  return media && method === "GET" ? response.text() : response.json();
};
const bucketURL = `https://storage.googleapis.com/storage/v1/b/${state.bucket}`;
const vertex = createVertex({ projectId: state.project, location: state.location, getAccessToken: async () => {
  const token = await auth.getAccessToken(); if (!token) throw new Error("Missing ADC token."); return token;
} });
const bounds = { maxRetries: 0, timeoutMs: 30_000 };
const terminal = new Set(["JOB_STATE_SUCCEEDED", "JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED", "JOB_STATE_PARTIALLY_SUCCEEDED"]);
const observe = async () => {
  if (!state.job) throw new Error("No job recorded; never restart automatically.");
  const job = await vertex.batches!.get({ name: state.job, ...bounds });
  state.state = job.state;
  if (state.cancelRequested && job.state === "JOB_STATE_CANCELLED") state.cancellationVerified = true;
  save();
  return job;
};
try {
  if (mode === "start") {
    await http(`https://storage.googleapis.com/storage/v1/b?project=${encodeURIComponent(state.project)}`, "POST", {
      name: state.bucket, location: "US-CENTRAL1", labels: { "zhivex-smoke": "vertex-batch" },
      iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: "enforced" },
      softDeletePolicy: { retentionDurationSeconds: "0" }
    });
    state.bucketCreated = true; save();
    const request = JSON.stringify(model.startsWith("claude-")
      ? { custom_id: "request-1", request: { anthropic_version: "vertex-2023-10-16", messages: [{ role: "user", content: `Reply exactly ${state.marker}` }], max_tokens: 128 } }
      : { request: { contents: [{ role: "user", parts: [{ text: `Reply exactly ${state.marker}` }] }], generationConfig: { maxOutputTokens: 256 } } }) + "\n";
    await http(`https://storage.googleapis.com/upload/storage/v1/b/${state.bucket}/o?uploadType=media&name=input.jsonl`, "POST", request, true);
    const job = await vertex.batches!.create({ modelId: model, displayName: state.bucket,
      fileName: `gs://${state.bucket}/input.jsonl`, ...bounds, providerOptions: {
        outputConfig: { predictionsFormat: "jsonl", gcsDestination: { outputUriPrefix: `gs://${state.bucket}/output/` } }
      } });
    state.job = job.name; state.state = job.state; save();
    console.log(JSON.stringify({ action: mode, state: job.state, statePath }));
  } else if (mode === "status") {
    const job = await observe();
    if (job.state === "JOB_STATE_SUCCEEDED" && !state.verified) {
      const list = await http(`${bucketURL}/o?prefix=output%2F&maxResults=100`);
      if (list.nextPageToken) throw new Error("Unexpected output object count; inspect before cleanup.");
      let matches = 0;
      for (const object of list.items ?? []) {
        if (!object.name.endsWith(".jsonl")) continue;
        const text = await http(`${bucketURL}/o/${encodeURIComponent(object.name)}?alt=media`, "GET", undefined, true);
        for (const line of text.split("\n").filter(Boolean)) {
          const record = JSON.parse(line);
          const output = model.startsWith("claude-")
            ? record.response?.content?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("")
            : record.response?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("");
          if (typeof output === "string" && output.includes(state.marker)) matches++;
        }
      }
      if (matches !== 1) throw new Error("Batch did not contain exactly one expected output.");
      state.verified = true; save();
    }
    console.log(JSON.stringify({ action: mode, state: state.state, terminal: terminal.has(state.state ?? ""), verified: !!state.verified, cancellationVerified: !!state.cancellationVerified }));
  } else if (mode === "cancel") {
    await observe();
    if (!terminal.has(state.state ?? "")) {
      const job = await vertex.batches!.cancel({ name: state.job!, ...bounds });
      state.cancelRequested = true; state.state = job.state; save();
      await observe();
    }
    console.log(JSON.stringify({ action: mode, state: state.state }));
  } else if (mode === "verify-cleanup") {
    const absent = async (request: () => Promise<unknown>) => {
      try { await request(); } catch (error) {
        if ((error as { status?: number }).status === 404) return;
        throw error;
      }
      throw new Error("Temporary resource still exists.");
    };
    await absent(() => http(bucketURL));
    if (state.job) await absent(() => vertex.batches!.get({ name: state.job!, ...bounds }));
    console.log(JSON.stringify({ action: mode, bucketStatus: 404, jobStatus: state.job ? 404 : "not-recorded" }));
  } else {
    if (state.cleaned) { console.log(JSON.stringify({ action: mode, alreadyCleaned: true })); process.exit(0); }
    if (state.job && !state.deleteOperation) {
      try { await observe(); }
      catch (error) {
        // A prior delete can succeed before its operation ID is saved. Confirm
        // absence instead of restarting or reporting a false cleanup failure.
        if ((error as { status?: number }).status === 404 && !state.bucketCreated) {
          state.cleaned = true; save();
          console.log(JSON.stringify({ action: mode, cleaned: true, verified: !!state.verified })); process.exit(0);
        }
        throw error;
      }
      if (!terminal.has(state.state ?? "")) throw new Error("Job is still active; cancel and observe terminal status before cleanup.");
    }
    if (state.bucketCreated) {
      const bucket = await http(bucketURL);
      if (bucket.labels?.["zhivex-smoke"] !== "vertex-batch") throw new Error("Bucket ownership label mismatch.");
      const objects = await http(`${bucketURL}/o?versions=true&maxResults=100`);
      if (objects.nextPageToken) throw new Error("Unexpected object count; refusing partial cleanup.");
      for (const object of objects.items ?? []) {
        if (object.name !== "input.jsonl" && !object.name.startsWith("output/")) throw new Error("Unexpected object in temporary bucket.");
      }
      for (const object of objects.items ?? []) await http(`${bucketURL}/o/${encodeURIComponent(object.name)}?generation=${object.generation}`, "DELETE");
      await http(bucketURL, "DELETE");
      state.bucketCreated = false; save();
    }
    if (state.job && !state.deleteOperation) {
      const deletion = await vertex.batches!.delete({ name: state.job, ...bounds });
      const operation = deletion.rawResponse as any;
      // Google canonicalizes project IDs to project numbers in resource names.
      const jobNamespace = state.job.split("/batchPredictionJobs/")[0];
      if (!operation?.name || !operation.name.startsWith(`${jobNamespace}/`) || operation.name.split("/").some((s: string) => s === ".." || s === ".")) throw new Error("Invalid deletion operation resource.");
      state.deleteOperation = operation.name; save();
    }
    if (state.deleteOperation) {
      const operation = await http(`https://${state.location}-aiplatform.googleapis.com/v1/${state.deleteOperation}`);
      if (operation.error) throw new Error("Batch deletion operation failed.");
      if (!operation.done) {
        console.log(JSON.stringify({ action: mode, pendingDeletion: true })); process.exit(0);
      }
    }
    state.cleaned = true; save();
    console.log(JSON.stringify({ action: mode, cleaned: true, verified: !!state.verified }));
  }
} catch (error) {
  // Resource names survive in the state file for recovery; never dump auth errors.
  console.log(JSON.stringify({ action: mode, ok: false, error: error instanceof Error ? error.name : "Error", status: (error as { status?: number }).status, statePath }));
  process.exitCode = 1;
}
