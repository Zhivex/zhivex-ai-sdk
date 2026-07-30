import { describe, expect, it } from "vitest";

import * as react from "../src/index.js";

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
  });
});
