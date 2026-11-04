import { describe, expect, it, vi } from "vitest";
import { createZAI } from "../src/index.js";
describe("GLM FlashX family", () => {
  it.each(["glm-5.3-flashx", "glm-5.3-flashx-legal"])("maps vision and mandatory shared reasoning for %s", async modelId => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ choices: [{ message: { content: "Image" }, finish_reason: "stop" }] }));
    const model = createZAI({ apiKey: "test", fetch: fetcher })(modelId);
    expect(model.capabilities).toMatchObject({ vision: true, reasoning: true, reasoningEfforts: ["low", "high", "max"] });
    const messages = [{ role: "user" as const, parts: [{ type: "image" as const, image: "https://example.com/a.png", mediaType: "image/png" }] }];
    await model.generate({ messages, reasoning: { effort: "max" } });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: "max", messages: [{ content: [{ type: "image_url" }] }] });
    await expect(model.generate({ messages, reasoning: { effort: "none" } })).rejects.toThrow();
    await expect(model.generate({ messages, providerOptions: { thinking: { type: "disabled" } } })).rejects.toThrow();
  });
});
