import { describe, expect, it } from "vitest";

import * as react from "../src/index.js";
import * as compat from "../src/compat.js";
import * as headless from "../src/headless.js";
import * as hooks from "../src/hooks.js";

describe("@zhivex-ai/react public surface", () => {
  it("exports the headless and component entry points", () => {
    expect(react.useZhivexChat).toBeTypeOf("function");
    expect(react.createFetchChatTransport).toBeTypeOf("function");
    expect(react.prepareChatRequestBody).toBeTypeOf("function");
    expect(react.parseChatEventStream).toBeTypeOf("function");
    expect(react.chatReducer).toBeTypeOf("function");
    expect(react.applyUIMessageChunk).toBeTypeOf("function");
    expect(react.ZhivexChat).toBeTypeOf("function");
    expect(react.MessageList).toBeTypeOf("function");
    expect(react.Composer).toBeTypeOf("function");
    expect(react.ChatBusyError).toBeTypeOf("function");
  });

  it("exposes dedicated headless and hooks entrypoints", () => {
    expect(headless.chatReducer).toBeTypeOf("function");
    expect(headless.ChatBusyError).toBeTypeOf("function");
    expect(hooks.useZhivexChat).toBeTypeOf("function");
  });

  it("exposes the beta AI SDK UI compatibility entrypoint", () => {
    expect(compat.fromAISDKUIMessage).toBeTypeOf("function");
    expect(compat.toAISDKUIMessage).toBeTypeOf("function");
    expect(compat.toAISDKUIMessageStreamResponse).toBeTypeOf("function");
    expect(compat.toAISDKUIRunnerStreamResponse).toBeTypeOf("function");
    expect(compat.parseAISDKUIMessageRequest).toBeTypeOf("function");
    expect(compat.createAISDKUIChatTransport).toBeTypeOf("function");
  });
});
