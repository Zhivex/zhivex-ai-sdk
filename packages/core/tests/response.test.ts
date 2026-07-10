import { describe, expect, it, vi } from "vitest";

import {
  ConfigurationError,
  ParseError,
  ProviderResponseTooLargeError,
  decodeBase64WithLimit,
  readBodyWithLimit,
  readErrorBodyWithLimit,
  readJsonWithLimit,
  resolveAudioResponseLimits
} from "../src/index.js";

const chunkedResponse = (chunks: number[][], options: { contentLength?: string; onCancel?: () => void } = {}) => {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (!chunk) {
        controller.close();
        return;
      }
      controller.enqueue(Uint8Array.from(chunk));
    },
    cancel() {
      options.onCancel?.();
    }
  });
  return new Response(body, {
    headers: options.contentLength === undefined ? undefined : { "content-length": options.contentLength }
  });
};

describe("bounded provider response readers", () => {
  it("rejects Content-Length above the limit before reading the body", async () => {
    const onCancel = vi.fn();
    const abort = vi.fn();
    const response = chunkedResponse([[1, 2, 3]], { contentLength: "10", onCancel });

    await expect(
      readBodyWithLimit(response, { maxBytes: 4, provider: "test", endpoint: "audio/speech", abort })
    ).rejects.toMatchObject({
      name: "ProviderResponseTooLargeError",
      maxBytes: 4,
      receivedBytes: 10,
      contentLength: 10
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("counts chunked bytes and cancels when a missing or false header understates the body", async () => {
    for (const contentLength of [undefined, "2"]) {
      const onCancel = vi.fn();
      const response = chunkedResponse([[1, 2, 3], [4, 5, 6]], { contentLength, onCancel });
      await expect(readBodyWithLimit(response, { maxBytes: 5 })).rejects.toBeInstanceOf(
        ProviderResponseTooLargeError
      );
      expect(onCancel).toHaveBeenCalledOnce();
    }
  });

  it("accepts a body exactly equal to the configured limit", async () => {
    const response = chunkedResponse([[1, 2], [3, 4]], { contentLength: "4" });
    await expect(readBodyWithLimit(response, { maxBytes: 4 })).resolves.toEqual(Uint8Array.from([1, 2, 3, 4]));
  });

  it("bounds JSON before parsing and reports malformed JSON", async () => {
    await expect(
      readJsonWithLimit(new Response('{"value":"too large"}'), { maxBytes: 5 })
    ).rejects.toBeInstanceOf(ProviderResponseTooLargeError);
    await expect(readJsonWithLimit(new Response("{"), { maxBytes: 5 })).rejects.toBeInstanceOf(ParseError);
    await expect(readJsonWithLimit<{ ok: boolean }>(new Response('{"ok":true}'), { maxBytes: 16 })).resolves.toEqual({
      ok: true
    });
  });

  it("truncates provider error bodies without replacing the HTTP error context", async () => {
    const onCancel = vi.fn();
    const response = chunkedResponse([[65, 66, 67], [68, 69, 70]], { onCancel });
    const body = await readErrorBodyWithLimit(response, 4);
    expect(body).toBe("ABCD\n...[truncated at 4 bytes]");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("validates decoded base64 size before allocating the output buffer", () => {
    expect(decodeBase64WithLimit("AQIDBA==", { maxBytes: 4 })).toEqual(Uint8Array.from([1, 2, 3, 4]));
    expect(() => decodeBase64WithLimit("AQIDBA==", { maxBytes: 3 })).toThrow(ProviderResponseTooLargeError);
    expect(() => decodeBase64WithLimit("%%%", { maxBytes: 4 })).toThrow(ParseError);
    expect(() => decodeBase64WithLimit("", { maxBytes: 4 })).toThrow(ParseError);
  });

  it("rejects invalid configured limits", () => {
    expect(() => resolveAudioResponseLimits({ speechBytes: 0 })).toThrow(ConfigurationError);
    expect(() => resolveAudioResponseLimits({ transcriptionBytes: Number.POSITIVE_INFINITY })).toThrow(
      ConfigurationError
    );
  });
});
