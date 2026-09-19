import { createVertex } from "../../vertex/src/index.js";
import { describe, expect, it, vi } from "vitest";
import { vertexIntegrationCredentials, vertexIntegrationProfile } from "./vertex-integration-profile.js";

describe("Vertex integration route contracts", () => {
  it("allows explicit ADC integration configuration without treating a project alone as credentials", () => {
    const env = { GOOGLE_CLOUD_PROJECT: "project", VERTEX_LOCATION: "us-east5" };
    expect(vertexIntegrationCredentials(env, true).configured).toBe(false);
    expect(vertexIntegrationCredentials({ ...env, VERTEX_INTEGRATION_USE_ADC: "1" }, true)).toMatchObject({
      configured: true, options: { projectId: "project", location: "us-east5", accessToken: undefined, apiKey: undefined }
    });
    expect(vertexIntegrationCredentials({ VERTEX_INTEGRATION_USE_ADC: "1" }, true).configured).toBe(false);
  });
  it("does not silently run ADC certification using a token or API key", () => {
    for (const name of ["VERTEX_ACCESS_TOKEN", "GOOGLE_ACCESS_TOKEN", "VERTEX_API_KEY", "GOOGLE_API_KEY"]) {
      for (const requiresBearer of [true, false]) {
        expect(vertexIntegrationCredentials({ GOOGLE_CLOUD_PROJECT: "project", VERTEX_INTEGRATION_USE_ADC: "1", [name]: "credential" }, requiresBearer).configured).toBe(false);
      }
    }
    expect(vertexIntegrationCredentials({ VERTEX_API_KEY: "key" }, false).configured).toBe(true);
    expect(vertexIntegrationCredentials({ VERTEX_API_KEY: "key", GOOGLE_CLOUD_PROJECT: "project" }, true).configured).toBe(false);
    expect(vertexIntegrationCredentials({ VERTEX_API_KEY: "key", VERTEX_ACCESS_TOKEN: "token", GOOGLE_CLOUD_PROJECT: "project" }, true).configured).toBe(true);
  });
  it("separates Gemini, Claude and managed partner authentication and reasoning", () => {
    expect(vertexIntegrationProfile("gemini-3.7-flash")).toMatchObject({ requiresBearer: false, omitTemperature: true, supports: { embeddings: true, reasoning: { effort: "low" } } });
    const claude = vertexIntegrationProfile("claude-sonnet-4-6");
    expect(claude).toMatchObject({ requiresBearer: true, omitTemperature: true, supports: { embeddings: false, structuredOutputMode: "native" } });
    expect(claude.toolChoiceForTool("sum")).toBe("auto");
    expect(vertexIntegrationProfile("xai/grok-4.1-fast-reasoning").supports.reasoning).toBeUndefined();
    expect(vertexIntegrationProfile("openai/gpt-oss-20b-maas").supports.reasoning).toEqual({ effort: "low" });
  });
  it("exercises the deployed GLM thinking toggle through the common reasoning profile", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    const vertex = createVertex({ projectId: "test", location: "global", accessToken: "synthetic", fetch });
    for (const modelId of ["zai-org/glm-4.7-maas", "zai-org/glm-5-maas", "zai-org/glm-5.2-maas"]) {
      const reasoning = vertexIntegrationProfile(modelId).supports.reasoning;
      expect(reasoning).toEqual({ effort: "low" });
      await vertex(modelId).generate({ messages: [{ role: "user", parts: [{ type: "text", text: "17 * 23" }] }], reasoning });
      const body = JSON.parse(fetch.mock.lastCall![1]!.body as string);
      expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
      expect(body.reasoning_effort).toBeUndefined();
    }
    for (const modelId of ["zai-org/glm-unknown", "zai-org/glm-5.20-maas", "xai/grok-4.20-reasoning", "moonshotai/kimi-k2-thinking-maas"]) {
      expect(vertexIntegrationProfile(modelId).supports.reasoning).toBeUndefined();
    }
  });
  it("does not certify Gemini features on an OCR model", () => {
    expect(vertexIntegrationProfile("deepseek-ai/deepseek-ocr-maas")).toMatchObject({ requiresBearer: true, supports: { tools: false, embeddings: false, structuredOutputMode: "prompted" } });
  });
});
