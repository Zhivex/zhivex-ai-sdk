import { describe, expect, it } from "vitest";

import * as sdk from "../src/index.js";

describe("sdk public surface", () => {
  it("exports the main quickstart helpers", () => {
    expect(sdk.generateText).toBeTypeOf("function");
    expect(sdk.streamText).toBeTypeOf("function");
    expect(sdk.generateObject).toBeTypeOf("function");
    expect(sdk.streamObject).toBeTypeOf("function");
    expect(sdk.embed).toBeTypeOf("function");
    expect(sdk.embedMany).toBeTypeOf("function");
    expect(sdk.toTextStreamResponse).toBeTypeOf("function");
    expect(sdk.toUIMessageStreamResponse).toBeTypeOf("function");
    expect(sdk.toUIMessage).toBeTypeOf("function");
    expect(sdk.wrapLanguageModel).toBeTypeOf("function");
    expect(sdk.createTelemetryMiddleware).toBeTypeOf("function");
    expect(sdk.createCachedGenerateMiddleware).toBeTypeOf("function");
    expect(sdk.createCircuitBreakerMiddleware).toBeTypeOf("function");
    expect(sdk.createFileGenerateCache).toBeTypeOf("function");
    expect(sdk.createModelCatalog).toBeTypeOf("function");
    expect(sdk.parseUIMessageRequest).toBeTypeOf("function");
    expect(sdk.tool).toBeTypeOf("function");
    expect(sdk.system).toBeTypeOf("function");
    expect(sdk.user).toBeTypeOf("function");
    expect(sdk.assistant).toBeTypeOf("function");
  });

  it("exports the provider factories used by the README", () => {
    expect(sdk.createOpenAI).toBeTypeOf("function");
    expect(sdk.createAzureOpenAI).toBeTypeOf("function");
    expect(sdk.createAnthropic).toBeTypeOf("function");
    expect(sdk.createGemini).toBeTypeOf("function");
    expect(sdk.createOpenRouter).toBeTypeOf("function");
    expect(sdk.createBedrock).toBeTypeOf("function");
    expect(sdk.createOllama).toBeTypeOf("function");
    expect(sdk.createGateway).toBeTypeOf("function");
  });
});
