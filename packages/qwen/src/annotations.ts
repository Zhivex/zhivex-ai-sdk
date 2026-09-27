import type { JsonValue } from "@zhivex-ai/core/provider";

// Public citation fields only: never forward a message, reasoning or logprobs.
export const createAnnotationCollector = () => {
  const seen = new Set<string>();
  return (part: any, outputIndex: unknown, contentIndex: unknown, itemId?: unknown): JsonValue | undefined => {
    if (!Number.isSafeInteger(outputIndex) || Number(outputIndex) < 0 ||
        !Number.isSafeInteger(contentIndex) || Number(contentIndex) < 0 || !Array.isArray(part?.annotations)) return;
    const annotations: Record<string, JsonValue>[] = [];
    for (const raw of part.annotations.slice(0, 1024)) {
      if (!raw || typeof raw !== "object" || raw.type !== "url_citation") continue;
      const source = raw.url_citation ?? raw;
      if (typeof source.url !== "string" || source.url.length > 8192) continue;
      try { const url = new URL(source.url); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) continue; } catch { continue; }
      const annotation: Record<string, JsonValue> = { type: "url_citation", url: source.url };
      if (typeof source.title === "string" && source.title.length <= 16384) annotation.title = source.title;
      for (const key of ["start_index", "end_index"]) {
        if (Number.isSafeInteger(source[key]) && source[key] >= 0) annotation[key] = source[key];
      }
      const key = JSON.stringify([outputIndex, contentIndex, annotation]);
      if (seen.has(key) || seen.size >= 4096) continue;
      seen.add(key);
      annotations.push(annotation);
    }
    if (!annotations.length) return;
    return { type: "response.annotations", outputIndex: Number(outputIndex), contentIndex: Number(contentIndex),
      ...(typeof itemId === "string" && itemId.length <= 1024 ? { itemId } : {}), annotations };
  };
};
