import { describe, expect, it } from "vitest";

import {
  ChatRequestError,
  MAX_CHAT_REQUEST_BYTES,
  optionalUserMessage,
  readChatJson,
  safeChatErrorResponse
} from "../examples/next-runner/lib/http";

describe("golden path starter request boundary", () => {
  it("accepts a bounded JSON object", async () => {
    const request = new Request("https://example.test/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" })
    });

    await expect(readChatJson(request)).resolves.toEqual({ message: "hello" });
  });

  it("rejects declared and streamed bodies above the limit", async () => {
    const declared = new Request("https://example.test/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_CHAT_REQUEST_BYTES + 1)
      },
      body: "{}"
    });
    await expect(readChatJson(declared)).rejects.toMatchObject({ status: 413 });

    const streamed = new Request("https://example.test/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "x".repeat(MAX_CHAT_REQUEST_BYTES) })
    });
    await expect(readChatJson(streamed)).rejects.toMatchObject({ status: 413 });
  });

  it("never returns unexpected error details to the browser", async () => {
    const request = new Request("https://example.test/api/chat");
    const response = safeChatErrorResponse(
      new Error("provider said secret-token-value"),
      request
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "Chat request failed." });
  });

  it("accepts only bounded text user messages", () => {
    expect(optionalUserMessage({
      id: "msg_1",
      role: "user",
      parts: [{ type: "text", text: "hello" }]
    })).toMatchObject({ id: "msg_1", role: "user" });
    expect(() => optionalUserMessage({
      id: "msg_2",
      role: "assistant",
      parts: [{ type: "text", text: "unexpected" }]
    })).toThrow(ChatRequestError);
    expect(() => optionalUserMessage({
      id: "msg_3",
      role: "user",
      parts: [{ type: "file", data: "payload" }]
    })).toThrow("text message parts only");
  });

  it("preserves only explicit safe request errors", async () => {
    const request = new Request("https://example.test/api/chat");
    const response = safeChatErrorResponse(
      new ChatRequestError("Request body is too large.", 413),
      request
    );

    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "Request body is too large." });
  });
});
