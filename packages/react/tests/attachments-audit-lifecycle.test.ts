// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAttachments } from "../src/attachments.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class Reader {
  static readers: Reader[] = [];
  result: string | ArrayBuffer | null = null;
  error: Error | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null = null;
  abort = vi.fn(() => this.onabort?.());
  readAsDataURL = vi.fn();
  constructor() { Reader.readers.push(this); }
}
afterEach(() => { vi.unstubAllGlobals(); Reader.readers = []; });

describe("attachment reader failures and cleanup", () => {
  it("shows progress, maps images/audio/files and aborts pending reads when removed", async () => {
    vi.stubGlobal("FileReader", Reader);
    let manager!: ReturnType<typeof useAttachments>;
    const onError = vi.fn();
    function App() { manager = useAttachments({ maxAttachments: 5, maxAttachmentBytes: 100, onError,
      errors: { limit: "limit", size: "size", type: "type", read: "read" } }); return null; }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(App)));
    try {
      await act(async () => manager.addFiles([
        new File(["x"], "image.png", { type: "image/png" }), new File(["x"], "audio.wav", { type: "audio/wav" }),
        new File(["x"], "file.txt", { type: "text/plain" }), new File(["x"], "cancel.txt", { type: "text/plain" })
      ]));
      await act(async () => Reader.readers[0]!.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 }));
      expect(manager.attachments[0]!.progress).toBe(0.5);
      await act(async () => {
        for (const reader of Reader.readers.slice(0, 3)) { reader.result = "data:application/octet-stream;base64,eA=="; reader.onload?.(); }
      });
      expect(manager.attachments.slice(0, 3).map(value => value.part?.type)).toEqual(["image", "audio", "file"]);
      expect(manager.attachments[1]!.part).toMatchObject({ filename: "audio.wav", mediaType: "audio/wav" });
      const removedId = manager.attachments[3]!.id;
      await act(async () => manager.remove(removedId));
      expect(Reader.readers[3]!.abort).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
      expect(manager.attachments).toHaveLength(3);
    } finally { await act(async () => root.unmount()); }
  });

  it("reports read errors and invalid reader results without exposing underlying diagnostics as UI text", async () => {
    vi.stubGlobal("FileReader", Reader);
    let manager!: ReturnType<typeof useAttachments>;
    const onError = vi.fn();
    function App() { manager = useAttachments({ maxAttachments: 2, maxAttachmentBytes: 100, onError,
      errors: { limit: "limit", size: "size", type: "type", read: "Cannot read attachment" } }); return null; }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(App)));
    try {
      await act(async () => manager.addFiles([new File(["x"], "fail.txt"), new File(["x"], "invalid.txt")]));
      await act(async () => {
        Reader.readers[0]!.error = new Error("filesystem private details"); Reader.readers[0]!.onerror?.();
        Reader.readers[1]!.result = new ArrayBuffer(1); Reader.readers[1]!.onload?.();
      });
      expect(manager.attachments.every(value => value.status === "error")).toBe(true);
      expect(onError).toHaveBeenCalledTimes(2);
      expect(manager.attachments.map(value => value.error?.message)).toEqual(["Cannot read attachment", "Cannot read attachment"]);
    } finally { await act(async () => root.unmount()); }
  });
});
