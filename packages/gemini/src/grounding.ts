import type { JsonValue } from "@zhivex-ai/core/provider";

const object = (value: any): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const text = (value: unknown, max = 16384) => typeof value === "string" && value.length <= max ? value : undefined;
const index = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const fields = (value: any, keys: string[]) => Object.fromEntries(keys.flatMap(key => {
  const val = text(object(value)[key]);
  return val === undefined ? [] : [[key, val]];
}));

// Arrays remain indexed snapshots: filtering chunks would corrupt citation indices.
export const createGroundingCollector = () => {
  let previous = "";
  let snapshot: Record<string, JsonValue> = {};
  return (raw: unknown, candidateIndex = 0): JsonValue | undefined => {
    const source = object(raw);
    const metadata: Record<string, JsonValue> = {};
    if (Array.isArray(source.groundingChunks)) metadata.groundingChunks = source.groundingChunks.slice(0, 1024).map((chunk: any): JsonValue => {
      const web = fields(object(chunk).web, ["uri", "title"]);
      if (typeof web.uri !== "string") return {};
      try { const url = new URL(web.uri); if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return {}; } catch { return {}; }
      return { web };
    });
    if (Array.isArray(source.groundingSupports)) metadata.groundingSupports = source.groundingSupports.slice(0, 4096).map((support: any) => {
      const segment = object(object(support).segment);
      return {
        segment: { ...fields(segment, ["text"]), ...Object.fromEntries(["startIndex", "endIndex", "partIndex"].filter(k => index(segment[k])).map(k => [k, segment[k]])) },
        groundingChunkIndices: Array.isArray(support?.groundingChunkIndices) ? support.groundingChunkIndices.filter(index).slice(0, 1024) : [],
        ...(Array.isArray(support?.confidenceScores) ? { confidenceScores: support.confidenceScores.filter((v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1).slice(0, 1024) } : {})
      };
    });
    const renderedContent = text(object(source.searchEntryPoint).renderedContent, 262144);
    if (renderedContent !== undefined) metadata.searchEntryPoint = { renderedContent };
    if (!Object.keys(metadata).length) return;
    snapshot = { ...snapshot, ...metadata };
    const data = { type: "grounding-metadata", candidateIndex, groundingMetadata: snapshot };
    const key = JSON.stringify(data);
    if (key === previous) return;
    previous = key;
    return data;
  };
};
