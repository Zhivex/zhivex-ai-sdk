"use client";
import { useEffect, useRef, useState } from "react";
import { supportsChatMediaType, validateChatInputParts, type ChatInputCapabilities } from "./input-capabilities.js";
import type { ChatInputPart } from "./types.js";

export interface AttachmentUploadContext {
  signal: AbortSignal;
  /** Fraction between 0 and 1. */
  onProgress: (progress: number) => void;
}
export type AttachmentUploader = (file: File, context: AttachmentUploadContext) => Promise<ChatInputPart>;
export interface ChatAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  status: "reading" | "uploading" | "ready" | "error";
  progress: number;
  previewUrl?: string;
  part?: ChatInputPart;
  error?: Error;
}

export const acceptsAttachment = (file: Pick<File, "name" | "type">, accept?: string): boolean => {
  const rules = accept?.split(",").map((rule) => rule.trim().toLowerCase()).filter(Boolean);
  if (!rules?.length) return true;
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return rules.some((rule) => rule.startsWith(".") ? name.endsWith(rule)
    : rule === "*/*" || (rule.endsWith("/*") ? type.startsWith(rule.slice(0, -1)) : type === rule));
};

const readAttachment: AttachmentUploader = (file, { signal, onProgress }) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  const abort = () => { reader.abort(); reject(signal.reason ?? new DOMException("Cancelled", "AbortError")); };
  if (signal.aborted) { abort(); return; }
  signal.addEventListener("abort", abort, { once: true });
  const cleanup = () => signal.removeEventListener("abort", abort);
  reader.onerror = () => { cleanup(); reject(reader.error ?? new Error("File read failed.")); };
  reader.onabort = cleanup;
  reader.onprogress = (event) => { if (event.lengthComputable) onProgress(event.loaded / event.total); };
  reader.onload = () => {
    cleanup();
    if (typeof reader.result !== "string") { reject(new Error("File read failed.")); return; }
    const mediaType = file.type || "application/octet-stream";
    resolve(mediaType.startsWith("image/") ? { type: "image", image: reader.result, mediaType }
      : mediaType.startsWith("audio/") ? { type: "audio", data: reader.result, mediaType, filename: file.name }
      : { type: "file", data: reader.result, mediaType, filename: file.name });
  };
  reader.readAsDataURL(file);
});

export function useAttachments(options: {
  inputCapabilities?: ChatInputCapabilities;
  accept?: string; maxAttachments: number; maxAttachmentBytes: number;
  uploadAttachment?: AttachmentUploader;
  onError?: (error: Error, file?: File) => void;
  errors: { limit: string; size: string; type: string; read: string };
}) {
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const entries = useRef(new Map<string, { file: File; controller: AbortController; value: ChatAttachment }>());
  const settings = useRef(options);
  settings.current = options;
  const publish = () => setAttachments([...entries.current.values()].map((entry) => entry.value));
  const remove = (id: string) => {
    const entry = entries.current.get(id);
    if (!entry) return;
    entries.current.delete(id);
    entry.controller.abort();
    if (entry.value.previewUrl) URL.revokeObjectURL(entry.value.previewUrl);
    publish();
  };
  const process = async (id: string) => {
    const entry = entries.current.get(id);
    if (!entry) return;
    const { controller, file } = entry;
    const current = () => entries.current.get(id) === entry && !controller.signal.aborted;
    try {
      const part = await (settings.current.uploadAttachment ?? readAttachment)(file, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (!current() || !Number.isFinite(progress)) return;
          entry.value = { ...entry.value, progress: Math.min(1, Math.max(0, progress)) };
          publish();
        }
      });
      if (!current()) return;
      if (!["image", "audio", "file"].includes(part.type)) throw new Error("An attachment must resolve to image, audio, or file content.");
      validateChatInputParts([part], settings.current.inputCapabilities);
      entry.value = { ...entry.value, status: "ready", part, progress: 1 };
      publish();
    } catch (cause) {
      if (!current()) return;
      const error = new Error(settings.current.errors.read, { cause });
      entry.value = { ...entry.value, status: "error", error };
      publish();
      settings.current.onError?.(error, file);
    }
  };
  const addFiles = (files: readonly File[]) => {
    for (const file of files) {
      const config = settings.current;
      const failure = entries.current.size >= config.maxAttachments ? config.errors.limit
        : file.size > config.maxAttachmentBytes ? config.errors.size
        : (!acceptsAttachment(file, config.accept) || !supportsChatMediaType(file.type, config.inputCapabilities)) ? config.errors.type : undefined;
      if (failure) { config.onError?.(new Error(failure), file); continue; }
      const id = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID()
        : `attachment_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
      const previewUrl = /^(image|audio|video)\//.test(file.type) && typeof URL.createObjectURL === "function"
        ? URL.createObjectURL(file) : undefined;
      entries.current.set(id, { file, controller: new AbortController(), value: {
        id, name: file.name, mediaType: file.type, size: file.size,
        status: config.uploadAttachment ? "uploading" : "reading", progress: 0, previewUrl
      } });
      publish();
      void process(id);
    }
  };
  const retry = (id: string) => {
    const entry = entries.current.get(id);
    if (!entry || entry.value.status !== "error") return;
    entry.controller = new AbortController();
    entry.value = { ...entry.value, status: settings.current.uploadAttachment ? "uploading" : "reading", error: undefined, progress: 0 };
    publish();
    void process(id);
  };
  useEffect(() => () => {
    for (const entry of entries.current.values()) {
      entry.controller.abort();
      if (entry.value.previewUrl) URL.revokeObjectURL(entry.value.previewUrl);
    }
    entries.current.clear();
  }, []);
  return { attachments, addFiles, remove, retry };
}
