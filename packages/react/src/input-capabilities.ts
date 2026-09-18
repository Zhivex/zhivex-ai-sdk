import type { ModelCapabilities } from "@zhivex-ai/core";
import type { ChatInputPart } from "./types.js";

export type ChatInputCapabilities = Pick<ModelCapabilities, "vision" | "audioInput" | "files" | "inputMediaTypes">;

/** Undefined means no model restriction. An empty string means text only. */
export function getChatAttachmentAccept(capabilities?: ChatInputCapabilities): string | undefined {
  if (!capabilities) return undefined;
  if (capabilities.inputMediaTypes) return capabilities.inputMediaTypes.join(",");
  return [capabilities.vision && "image/*", capabilities.audioInput && "audio/*", capabilities.files && "*/*"].filter(Boolean).join(",");
}

export function supportsChatMediaType(mediaType: string, capabilities?: ChatInputCapabilities): boolean {
  const accept = getChatAttachmentAccept(capabilities);
  if (accept === undefined) return true;
  const type = mediaType.toLowerCase().split(";")[0]!.trim();
  return accept.split(",").some(rule => {
    rule = rule.trim().toLowerCase();
    return !!rule && (rule === "*/*" || rule === type || (rule.endsWith("/*") && type.startsWith(rule.slice(0, -1))));
  });
}

export function validateChatInputParts(parts: readonly ChatInputPart[], capabilities?: ChatInputCapabilities): void {
  if (!capabilities) return;
  for (const part of parts) {
    if (part.type === "text") continue;
    const mediaType = part.mediaType ?? (part.type === "image" ? "image/*" : "application/octet-stream");
    if (!supportsChatMediaType(mediaType, capabilities)) throw new TypeError(`The selected model does not accept ${mediaType} attachments.`);
  }
}
