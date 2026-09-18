// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { acceptsAttachment, useAttachments } from "../src/attachments.js";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("attachment lifecycle", () => {
  it("validates MIME wildcards and extensions consistently", () => {
    expect(acceptsAttachment({ name: "REPORT.TXT", type: "" }, ".txt,image/*")).toBe(true);
    expect(acceptsAttachment({ name: "photo", type: "image/png" }, ".txt,image/*")).toBe(true);
    expect(acceptsAttachment({ name: "bad.pdf", type: "application/pdf" }, ".txt,image/*")).toBe(false);
  });
  it("reserves slots while uploading, ignores cancelled completions and retries failures", async () => {
    const node = document.createElement("div");
    const root = createRoot(node);
    let manager!: ReturnType<typeof useAttachments>;
    const pending: Array<{ signal: AbortSignal; resolve: (part: { type: "file"; data: string; mediaType: string }) => void; reject: (error: Error) => void }> = [];
    const onError = vi.fn();
    function Harness() {
      manager = useAttachments({ maxAttachments: 1, maxAttachmentBytes: 100, accept: ".txt", onError,
        errors: { limit: "limit", size: "size", type: "type", read: "read" },
        uploadAttachment: (_file, { signal }) => new Promise((resolve, reject) => pending.push({ signal, resolve, reject })) });
      return null;
    }
    await act(async () => root.render(createElement(Harness)));
    await act(async () => {
      manager.addFiles([new File(["a"], "a.txt")]);
      manager.addFiles([new File(["b"], "b.txt")]);
    });
    expect(manager.attachments).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
    const firstId = manager.attachments[0]!.id;
    await act(async () => manager.remove(firstId));
    expect(pending[0]!.signal.aborted).toBe(true);
    await act(async () => pending[0]!.resolve({ type: "file", data: "stale", mediaType: "text/plain" }));
    expect(manager.attachments).toHaveLength(0);
    await act(async () => manager.addFiles([new File(["a"], "retry.txt")]));
    await act(async () => pending[1]!.reject(new Error("offline")));
    expect(manager.attachments[0]!.status).toBe("error");
    await act(async () => manager.retry(manager.attachments[0]!.id));
    await act(async () => pending[2]!.resolve({ type: "file", data: "https://files.example/file", mediaType: "text/plain" }));
    expect(manager.attachments[0]!.status).toBe("ready");
    await act(async () => root.unmount());
  });
});
