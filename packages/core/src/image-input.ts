import { ValidationError } from "./errors.js";
import type { ImagePart } from "./types.js";

/** Serialize a shared image input for providers accepting URLs or base64 data URLs. */
export const imageInputToDataUrl = (part: ImagePart): string => {
  if (typeof part.image !== "string" || !part.image.trim()) {
    throw new ValidationError("Image input must be a non-empty string.");
  }
  if (part.mediaType !== undefined && !/^image\/[a-z0-9][a-z0-9.+-]*$/i.test(part.mediaType)) {
    throw new ValidationError("Image mediaType must be an image/* MIME type without parameters.");
  }
  if (/^https?:\/\//i.test(part.image)) return part.image;
  if (/^data:/i.test(part.image)) {
    if (!/^data:image\/[a-z0-9][a-z0-9.+-]*;base64,[a-z0-9+/]+={0,2}$/i.test(part.image)) {
      throw new ValidationError("Image data URL must contain a base64 image/* payload.");
    }
    return part.image;
  }
  if (!/^[a-z0-9+/]+={0,2}$/i.test(part.image)) {
    throw new ValidationError("Image input must be HTTP(S), an image data URL, or base64.");
  }
  if (!part.mediaType) {
    throw new ValidationError("Base64 image input requires mediaType.");
  }
  return `data:${part.mediaType};base64,${part.image}`;
};
