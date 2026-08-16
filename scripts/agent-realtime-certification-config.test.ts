import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { resolveAgentRealtimeCertificationConfig } from "./agent-realtime-certification-config.js";

const completeEnvironment = {
  ZHIVEX_LIVE_AGENT_CERTIFICATION: "1",
  GEMINI_API_KEY: "gemini-secret",
  ZHIVEX_LIVE_AGENT_GEMINI_MODEL: "gemini-live",
  QWEN_API_KEY: "qwen-secret",
  ZHIVEX_LIVE_AGENT_QWEN_MODEL: "qwen-realtime",
  OPENAI_API_KEY: "openai-secret",
  ZHIVEX_LIVE_AGENT_OPENAI_MODEL: "gpt-realtime"
};

describe("agent realtime certification config", () => {
  it("stays disabled without the explicit activation flag", () => {
    expect(resolveAgentRealtimeCertificationConfig({
      ZHIVEX_AGENT_REALTIME_TIMEOUT_MS: "invalid-while-disabled"
    })).toEqual({
      enabled: false,
      timeoutMs: 45_000,
      providers: []
    });
  });

  it("fails closed when an activated provider credential is missing", () => {
    const { OPENAI_API_KEY: _removed, ...environment } = completeEnvironment;

    expect(() => resolveAgentRealtimeCertificationConfig(environment)).toThrow(
      "OPENAI_API_KEY"
    );
  });

  it("uses explicit current realtime model defaults when overrides are absent", () => {
    expect(resolveAgentRealtimeCertificationConfig({
      ZHIVEX_LIVE_AGENT_CERTIFICATION: "1",
      GEMINI_API_KEY: "gemini-secret",
      ZHIVEX_LIVE_AGENT_GEMINI_MODEL: " ",
      QWEN_API_KEY: "qwen-secret",
      ZHIVEX_LIVE_AGENT_QWEN_MODEL: "",
      OPENAI_API_KEY: "openai-secret"
    }).providers).toEqual([
      {
        name: "gemini",
        apiKey: "gemini-secret",
        modelId: "gemini-3.1-flash-live-preview"
      },
      {
        name: "qwen",
        apiKey: "qwen-secret",
        modelId: "qwen3.5-omni-plus-realtime"
      },
      {
        name: "openai",
        apiKey: "openai-secret",
        modelId: "gpt-realtime"
      }
    ]);
  });

  it("requires and returns the complete Gemini, Qwen, and OpenAI matrix", () => {
    expect(resolveAgentRealtimeCertificationConfig(completeEnvironment)).toEqual({
      enabled: true,
      timeoutMs: 45_000,
      providers: [
        { name: "gemini", apiKey: "gemini-secret", modelId: "gemini-live" },
        { name: "qwen", apiKey: "qwen-secret", modelId: "qwen-realtime" },
        { name: "openai", apiKey: "openai-secret", modelId: "gpt-realtime" }
      ]
    });
  });

  it("accepts credential aliases and validates the timeout", () => {
    const {
      GEMINI_API_KEY: _gemini,
      QWEN_API_KEY: _qwen,
      ...environment
    } = completeEnvironment;

    expect(
      resolveAgentRealtimeCertificationConfig({
        ...environment,
        GOOGLE_GENERATIVE_AI_API_KEY: "google-secret",
        DASHSCOPE_API_KEY: "dashscope-secret",
        ZHIVEX_AGENT_REALTIME_TIMEOUT_MS: "60000"
      })
    ).toMatchObject({
      timeoutMs: 60_000,
      providers: [
        { name: "gemini", apiKey: "google-secret" },
        { name: "qwen", apiKey: "dashscope-secret" },
        { name: "openai", apiKey: "openai-secret" }
      ]
    });

    expect(() =>
      resolveAgentRealtimeCertificationConfig({
        ...completeEnvironment,
        ZHIVEX_AGENT_REALTIME_TIMEOUT_MS: "999"
      })
    ).toThrow("between 1000 and 120000");
  });

  it("keeps the dedicated package command fail-closed", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as { scripts?: Record<string, string> };

    expect(manifest.scripts?.["test:integration:agents-realtime"]).toBe(
      "ZHIVEX_LIVE_AGENT_CERTIFICATION=1 vitest run --config vitest.integration.config.ts packages/core/tests/agent-realtime-live.integration.test.ts"
    );
  });
});
