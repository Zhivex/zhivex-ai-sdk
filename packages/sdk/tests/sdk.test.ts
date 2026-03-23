import { describe, expect, it } from "vitest";

import * as sdk from "../src/index.js";

describe("sdk public surface", () => {
  it("exports the shared helpers from core", () => {
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

  it("does not re-export provider factories", () => {
    expect("createOpenAI" in sdk).toBe(false);
    expect("createAzureOpenAI" in sdk).toBe(false);
    expect("createAnthropic" in sdk).toBe(false);
    expect("createGemini" in sdk).toBe(false);
    expect("createOpenRouter" in sdk).toBe(false);
    expect("createBedrock" in sdk).toBe(false);
    expect("createOllama" in sdk).toBe(false);
    expect("createGateway" in sdk).toBe(false);
  });
});
