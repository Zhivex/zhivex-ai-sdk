import { ConfigurationError, ProviderHTTPError } from "@zhivex-ai/core";
import { cloudRequest, requireCloudText, requireCloudURL, type QwenCloudRequestOptions } from "./cloud-media.js";
export type QwenWorldModelId = "happyoyster-1.0-adventure" | "happyoyster-1.0-directing" | "happyoyster-1.0-acting";
export type QwenWorldImage = ({ url: string; base64?: never } | { base64: string; url?: never }) & { referenceType?: "default" };
export interface QwenWorldCreateInput extends QwenCloudRequestOptions {
  prompt?: string; creationModel?: "simple" | "scriptlist"; scriptList?: QwenWorldScript; firstFrameImage?: QwenWorldImage; async?: boolean; refWorldId?: string;
  perspective?: "first_person" | "third_person"; eventStyle?: "normal" | "dramatic";
  resolution?: "480p" | "720p"; aspectRatio?: "9:16" | "16:9";
  layout?: "Stable" | "Fast" | "Calm"; narrative?: "Calm" | "Dramatic" | "Normal" | "Steady"; inputImages?: QwenWorldImage[];
}
export interface QwenWorldAct {
  turn?: number; content: string;
  cameraType?: "Static" | "Tracking" | "Pan Left" | "Pan Right" | "Tilt Up" | "Tilt Down" | "Push-in" | "Pull-out" | "POV Forward" | "POV Look Down" | "POV Look Up" | "POV Turn Left" | "POV Turn Right";
  shotSize?: "Wide" | "Medium" | "Close-up";
  cut?: "long-take" | "hard-cut" | "cut-in" | "cut-out" | "cutaway" | "cutback" | "camera movement transition";
}
export interface QwenWorldScript {
  synopsis: string; acts: QwenWorldAct[]; videoTitle?: string; scene?: string; style?: string; speed?: string; language?: string;
  setting?: string; soundtrack?: string; prologue?: string; videoTags?: string[];
  subjects?: Array<{ label?: string; name?: string; type?: "character" | "animal" | "creature" | "narrator"; refImage?: QwenWorldImage; gender?: string; position?: string; ethnicity?: string; age?: string; appearance?: string; voice?: string }>;
}
export interface QwenWorld { encryptedWorldId: string; status: "generating" | "ready" | "failed"; firstFrame?: string | null; [key: string]: unknown }
export interface QwenTravelCredential { ticket: string; expiresIn: number; encryptedWorldId: string }
export interface QwenWorldList { items: QwenWorld[]; pagination: { page: number; pageSize: number; total: number; hasMore: boolean } }
export interface QwenTravel { encryptedTravelId: string; encryptedWorldId?: string; rtcConfig?: { channelId: string; appId: string; token: string; userId: string } | null; [key: string]: unknown }
export interface QwenWorldsClient {
  readonly modelId: QwenWorldModelId;
  create(input: QwenWorldCreateInput): Promise<QwenWorld>;
  buildStatus(worldId: string, options?: QwenCloudRequestOptions): Promise<QwenWorld>;
  get(worldId: string, options?: QwenCloudRequestOptions): Promise<QwenWorld>;
  list(options?: QwenCloudRequestOptions & { page?: number; pageSize?: number; status?: QwenWorld["status"] }): Promise<QwenWorldList>;
  delete(worldId: string, options?: QwenCloudRequestOptions): Promise<{ encryptedWorldId: string; deleted: boolean }>;
  getTravelCredential(worldId: string, options?: QwenCloudRequestOptions): Promise<QwenTravelCredential>;
  enterTravel(input: QwenCloudRequestOptions & { ticket: string; maxExperienceTimeSec?: 60 | 90 | 120 }): Promise<QwenTravel>;
  rewindTravel(travelId: string, rewindToSec: number, options?: QwenCloudRequestOptions): Promise<QwenTravel>;
  listTravels(options?: QwenCloudRequestOptions & { page?: number; pageSize?: number; status?: "init" | "pending" | "running" | "paused" | "failed" | "completed"; worldId?: string }): Promise<{ items: QwenTravel[]; pagination: QwenWorldList["pagination"] }>;
  travelStatus(travelId: string, options?: QwenCloudRequestOptions): Promise<QwenTravel>;
  travelArtifacts(travelId: string, options?: QwenCloudRequestOptions): Promise<QwenTravel>;
  pauseTravel(travelId: string, options?: QwenCloudRequestOptions): Promise<QwenTravel>;
  resumeTravel(travelId: string, options?: QwenCloudRequestOptions): Promise<QwenTravel>;
  instructTravel(travelId: string, input: QwenCloudRequestOptions & { content: string; clientRequestId?: string }): Promise<QwenTravel>;
  updateScript(travelId: string, acts: QwenWorldAct[], options?: QwenCloudRequestOptions): Promise<QwenTravel>;
  endTravel(travelId: string, options?: QwenCloudRequestOptions & { failCode?: "TRAVEL_NO_STREAM_AUTO_END"; userAgent?: string }): Promise<QwenTravel>;
}
function image(value: QwenWorldImage): void {
  if (!value || (!!value.url === !!value.base64)) throw new ConfigurationError("World image requires exactly one URL or base64 value.");
  if (value.url) requireCloudURL(value.url);
  else if (typeof value.base64 !== "string" || !/^data:image\/(?:jpeg|jpg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value.base64) || value.base64.length >= 8 * 1024 * 1024) throw new ConfigurationError("World image must be an image data URI smaller than 6 MiB.");
}
function acts(items: QwenWorldAct[], complete = false): void {
  if (!Array.isArray(items) || items.length < 1 || items.length > 45 || (complete && items.length !== 45)) throw new ConfigurationError("Scripts require 1–45 acts; full updates require exactly 45.");
  const turns = new Set<number>();
  for (const act of items) {
    requireCloudText(act.content, "act content", 2000);
    if (act.turn !== undefined) {
      if (!Number.isInteger(act.turn) || act.turn < 1 || act.turn > 45 || turns.has(act.turn)) throw new ConfigurationError("Act turns must be unique integers 1–45.");
      turns.add(act.turn);
    } else if (complete) throw new ConfigurationError("Full script updates require explicit turns 1–45.");
    if (act.cameraType !== undefined && !["Static", "Tracking", "Pan Left", "Pan Right", "Tilt Up", "Tilt Down", "Push-in", "Pull-out", "POV Forward", "POV Look Down", "POV Look Up", "POV Turn Left", "POV Turn Right"].includes(act.cameraType)) throw new ConfigurationError("Invalid cameraType.");
    if (act.shotSize !== undefined && !["Wide", "Medium", "Close-up"].includes(act.shotSize)) throw new ConfigurationError("Invalid shotSize.");
    if (act.cut !== undefined && !["long-take", "hard-cut", "cut-in", "cut-out", "cutaway", "cutback", "camera movement transition"].includes(act.cut)) throw new ConfigurationError("Invalid cut.");
  }
}
function script(value: QwenWorldScript): void {
  requireCloudText(value?.synopsis, "synopsis", 2000); acts(value.acts);
  for (const [key, max] of Object.entries({ videoTitle: 128, scene: 64, style: 64, speed: 64, language: 64, setting: 2000, soundtrack: 500, prologue: 1000 })) {
    const field = value[key as keyof QwenWorldScript]; if (field !== undefined) requireCloudText(field, key, max);
  }
  if ((value.videoTags?.length ?? 0) > 20) throw new ConfigurationError("At most 20 videoTags.");
  value.videoTags?.forEach(tag => requireCloudText(tag, "videoTag", 32));
  if ((value.subjects?.length ?? 0) > 6) throw new ConfigurationError("At most six subjects.");
  for (const subject of value.subjects ?? []) { if (subject.refImage) image(subject.refImage); }
}
function world(data: any): QwenWorld {
  requireCloudText(data?.encryptedWorldId, "response world ID");
  if (!["generating", "ready", "failed"].includes(data.status)) throw new ConfigurationError("Invalid world status.");
  return data;
}
export function createQwenWorldsClient(modelId: QwenWorldModelId, apiKey: string, taskBaseURL: string, fetcher: typeof globalThis.fetch): QwenWorldsClient {
  if (!["happyoyster-1.0-adventure", "happyoyster-1.0-directing", "happyoyster-1.0-acting"].includes(modelId)) throw new ConfigurationError("Unsupported world model.");
  // Keep a custom gateway prefix while replacing the documented API version.
  if (!/\/api\/v1\/?$/.test(taskBaseURL)) throw new ConfigurationError("Worlds require taskBaseURL ending in /api/v1.");
  const base = taskBaseURL.replace(/\/api\/v1\/?$/, `/api/v2/apps/${modelId}/openapi/v1`);
  const request = async (path: string, options: QwenCloudRequestOptions, body?: unknown) => {
    const envelope = await cloudRequest(apiKey, `${base}${path}`, fetcher, options, body);
    // The public maas gateway wraps the Open API envelope in output.
    const json = envelope.output ?? envelope;
    if (json && typeof json.code === "number" && json.code !== 0) throw new ProviderHTTPError("HappyOyster request failed.", 200, { responseBody: { code: json.code } });
    if (json.code !== 0 || !json.data || typeof json.data !== "object" || Array.isArray(json.data)) throw new ConfigurationError("Invalid HappyOyster response.");
    return json.data;
  };
  const id = (value: string) => { requireCloudText(value, "identifier", 2048); return encodeURIComponent(value); };
  return { modelId,
    async create(input) {
      if (input.creationModel !== undefined && !["simple", "scriptlist"].includes(input.creationModel)) throw new ConfigurationError("Invalid creationModel.");
      if (input.creationModel === "scriptlist") {
        if (modelId !== "happyoyster-1.0-directing" || !input.scriptList) throw new ConfigurationError("scriptlist is available only for Directing and requires scriptList.");
        script(input.scriptList);
      } else { requireCloudText(input.prompt, "prompt", 2000); if (input.scriptList) throw new ConfigurationError("scriptList requires creationModel=scriptlist."); }
      if (modelId === "happyoyster-1.0-directing" && !input.resolution) throw new ConfigurationError("Directing requires resolution.");
      if (modelId !== "happyoyster-1.0-directing" && !input.firstFrameImage) throw new ConfigurationError("This world model requires firstFrameImage.");
      if (modelId === "happyoyster-1.0-adventure" && !["first_person", "third_person"].includes(input.perspective ?? "")) throw new ConfigurationError("Adventure requires perspective.");
      if (input.firstFrameImage) image(input.firstFrameImage);
      if ((input.inputImages?.length ?? 0) > 6) throw new ConfigurationError("At most six reference images are supported.");
      input.inputImages?.forEach(image);
      if (input.resolution !== undefined && !["480p", "720p"].includes(input.resolution)) throw new ConfigurationError("Invalid world resolution.");
      if (input.aspectRatio !== undefined && (modelId !== "happyoyster-1.0-acting" || !["9:16", "16:9"].includes(input.aspectRatio))) throw new ConfigurationError("aspectRatio applies only to Acting (9:16 or 16:9).");
      if (modelId !== "happyoyster-1.0-directing" && (input.layout !== undefined || input.narrative !== undefined || input.inputImages !== undefined)) throw new ConfigurationError("layout, narrative and inputImages apply only to Directing.");
      for (const [key, allowed] of Object.entries({ perspective: ["first_person", "third_person"], eventStyle: ["normal", "dramatic"], layout: ["Stable", "Fast", "Calm"], narrative: ["Calm", "Dramatic", "Normal", "Steady"] })) {
        const value = input[key as keyof QwenWorldCreateInput]; if (value !== undefined && !allowed.includes(String(value))) throw new ConfigurationError(`Invalid ${key}.`);
      }
      if (input.async !== undefined && typeof input.async !== "boolean") throw new ConfigurationError("async must be boolean.");
      const body = { prompt: input.prompt, firstFrameImage: input.firstFrameImage, refWorldId: input.refWorldId, perspective: input.perspective, eventStyle: input.eventStyle, resolution: input.resolution, aspectRatio: input.aspectRatio, layout: input.layout, narrative: input.narrative, inputImages: input.inputImages, scriptList: input.scriptList };
      return world(await request("/worlds", input, { ...body, async: input.async ?? true, creationModel: input.creationModel ?? "simple" }));
    },
    async buildStatus(worldId, options = {}) { return world(await request(`/worlds/build-status?encryptedWorldId=${id(worldId)}`, options)); },
    async get(worldId, options = {}) { return world(await request(`/worlds/detail?encryptedWorldId=${id(worldId)}`, options)); },
    async list(options = {}) {
      const page = options.page ?? 1, pageSize = options.pageSize ?? 20;
      if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new ConfigurationError("Invalid world pagination.");
      const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (options.status) query.set("status", options.status);
      const data = await request(`/worlds?${query}`, options);
      if (!Array.isArray(data.items) || !data.pagination) throw new ConfigurationError("Invalid world list.");
      data.items.forEach(world); return data;
    },
    async delete(worldId, options = {}) { id(worldId); const data = await request("/worlds/delete", options, { encryptedWorldId: worldId }); if (data.encryptedWorldId !== worldId || typeof data.deleted !== "boolean") throw new ConfigurationError("Invalid world deletion response."); return data; },
    async getTravelCredential(worldId, options = {}) {
      id(worldId); const data = await request("/worlds/get-travel-credential", options, { encryptedWorldId: worldId });
      requireCloudText(data.ticket, "response ticket");
      if (data.encryptedWorldId !== worldId || !Number.isFinite(data.expiresIn) || data.expiresIn <= 0) throw new ConfigurationError("Invalid travel credential.");
      return data;
    },
    async enterTravel(input) {
      requireCloudText(input.ticket, "ticket");
      if (input.maxExperienceTimeSec !== undefined && (modelId !== "happyoyster-1.0-adventure" || ![60, 90, 120].includes(input.maxExperienceTimeSec))) throw new ConfigurationError("Adventure duration must be 60, 90 or 120 seconds; other modes do not accept a duration.");
      const data = await request("/travels/enter-travel", input, { ticket: input.ticket, maxExperienceTimeSec: input.maxExperienceTimeSec });
      requireCloudText(data.encryptedTravelId, "response travel ID"); return data;
    },
    async rewindTravel(travelId, rewindToSec, options = {}) {
      if (modelId !== "happyoyster-1.0-directing") throw new ConfigurationError("Only Directing supports rewind.");
      id(travelId); if (!Number.isFinite(rewindToSec) || rewindToSec < 0) throw new ConfigurationError("rewindToSec must be nonnegative.");
      return request("/travels/rewind", options, { encryptedTravelId: travelId, rewindToSec });
    },
    async listTravels(options = {}) {
      const page = options.page ?? 1, pageSize = options.pageSize ?? 20;
      if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new ConfigurationError("Invalid travel pagination.");
      const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (options.status) query.set("status", options.status);
      if (options.worldId) { id(options.worldId); query.set("encryptedWorldId", options.worldId); }
      const data = await request(`/travels?${query}`, options);
      if (!Array.isArray(data.items) || !data.pagination) throw new ConfigurationError("Invalid travel list.");
      for (const item of data.items) requireCloudText(item.encryptedTravelId, "travel ID");
      return data;
    },
    async travelStatus(travelId, options = {}) { const data = await request(`/travels/status?encryptedTravelId=${id(travelId)}`, options); if (data.encryptedTravelId !== travelId) throw new ConfigurationError("Invalid travel response."); return data; },
    async travelArtifacts(travelId, options = {}) { const data = await request(`/travels/artifacts?encryptedTravelId=${id(travelId)}`, options); if (data.encryptedTravelId !== travelId) throw new ConfigurationError("Invalid travel response."); return data; },
    async pauseTravel(travelId, options = {}) { if (modelId === "happyoyster-1.0-adventure") throw new ConfigurationError("Adventure does not support pause."); id(travelId); return request("/travels/pause", options, { encryptedTravelId: travelId }); },
    async resumeTravel(travelId, options = {}) { if (modelId === "happyoyster-1.0-adventure") throw new ConfigurationError("Adventure does not support resume."); id(travelId); return request("/travels/resume", options, { encryptedTravelId: travelId }); },
    async instructTravel(travelId, input) {
      if (modelId === "happyoyster-1.0-adventure") throw new ConfigurationError("Adventure controls require the official RTC SDK sendCommand API.");
      id(travelId); requireCloudText(input.content, "instruction", 2000);
      if (input.clientRequestId !== undefined && !/^[A-Za-z0-9_-]{1,32}$/.test(input.clientRequestId)) throw new ConfigurationError("Invalid clientRequestId.");
      return request("/travels/instruct", input, { encryptedTravelId: travelId, content: input.content, clientRequestId: input.clientRequestId });
    },
    async updateScript(travelId, items, options = {}) { if (modelId !== "happyoyster-1.0-directing") throw new ConfigurationError("Script updates require Directing."); id(travelId); acts(items, true); return request("/travels/update-script", options, { encryptedTravelId: travelId, scriptList: { acts: items } }); },
    async endTravel(travelId, options = {}) { id(travelId); const data = await request("/travels/end", options, { encryptedTravelId: travelId, failCode: options.failCode, userAgent: options.userAgent }); if (data.encryptedTravelId !== travelId) throw new ConfigurationError("Invalid end-travel response."); return data; }
  };
}
