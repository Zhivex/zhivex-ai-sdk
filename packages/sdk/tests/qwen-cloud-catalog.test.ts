import { expect, it } from "vitest";
import { defaultModelCatalog } from "../src/index.js";
it("discovers Cloud specialty models without recommending them as chat models", () => {
  for (const id of ["decision-model-preview", "qwen-audio-3.1-realtime-plus", "qwen-image-3.0", "happyoyster-1.0-acting", "qwen3.7-text-embedding"]) {
    const entry = defaultModelCatalog.find("qwen", id);
    expect(entry?.modelId).toBe(id);
    expect(entry?.recommendedFor ?? []).not.toContain("chat");
  }
});
