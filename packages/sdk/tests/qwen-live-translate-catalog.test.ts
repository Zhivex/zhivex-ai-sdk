import { expect, it } from "vitest";
import { defaultModelCatalog } from "../src/index.js";
it("exposes Qwen LiveTranslate through the unified SDK catalog", () => {
  expect(defaultModelCatalog.find("qwen", "qwen3.8-livetranslate-flash-realtime")?.modelId).toBe("qwen3.8-livetranslate-flash-realtime");
});
