import { Buffer } from "node:buffer";

import { ConfigurationError, ParseError, ProviderResponseTooLargeError } from "./errors.js";

const MIB = 1024 * 1024;
const DEFAULT_SPEECH_BYTES = 16 * MIB;
const DEFAULT_TRANSCRIPTION_BYTES = 4 * MIB;
const DEFAULT_ERROR_BODY_BYTES = 64 * 1024;
const DEFAULT_JSON_OVERHEAD_BYTES = MIB;

export interface AudioResponseLimits {
  speechBytes?: number;
  speechJsonBytes?: number;
  transcriptionBytes?: number;
  errorBodyBytes?: number;
}

export interface ResolvedAudioResponseLimits {
  speechBytes: number;
  speechJsonBytes: number;
  transcriptionBytes: number;
  errorBodyBytes: number;
}

export interface ResponseBodyLimitOptions {
  maxBytes: number;
  provider?: string;
  endpoint?: string;
  abort?: (reason?: unknown) => void;
}

const normalizePositiveLimit = (value: number | undefined, fallback: number, name: string) => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new ConfigurationError(`The "${name}" response limit must be a positive safe integer.`);
  }
  return resolved;
};

const encodedBase64Length = (decodedBytes: number) => 4 * Math.ceil(decodedBytes / 3);

export const resolveAudioResponseLimits = (limits: AudioResponseLimits = {}): ResolvedAudioResponseLimits => {
  const speechBytes = normalizePositiveLimit(limits.speechBytes, DEFAULT_SPEECH_BYTES, "speechBytes");
  return {
    speechBytes,
    speechJsonBytes: normalizePositiveLimit(
      limits.speechJsonBytes,
      encodedBase64Length(speechBytes) + DEFAULT_JSON_OVERHEAD_BYTES,
      "speechJsonBytes"
    ),
    transcriptionBytes: normalizePositiveLimit(
      limits.transcriptionBytes,
      DEFAULT_TRANSCRIPTION_BYTES,
      "transcriptionBytes"
    ),
    errorBodyBytes: normalizePositiveLimit(limits.errorBodyBytes, DEFAULT_ERROR_BODY_BYTES, "errorBodyBytes")
  };
};

const contentLengthFromResponse = (response: Response) => {
  const raw = response.headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw.trim())) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
};

const tooLargeError = (
  options: ResponseBodyLimitOptions,
  receivedBytes: number,
  contentLength?: number
) =>
  new ProviderResponseTooLargeError({
    maxBytes: options.maxBytes,
    receivedBytes,
    contentLength,
    provider: options.provider,
    endpoint: options.endpoint
  });

const abortRead = (options: ResponseBodyLimitOptions, reason: unknown) => {
  try {
    options.abort?.(reason);
  } catch {
    // Best-effort cancellation must not hide the size-limit error.
  }
};

export const readBodyWithLimit = async (
  response: Response,
  options: ResponseBodyLimitOptions
): Promise<Uint8Array> => {
  const maxBytes = normalizePositiveLimit(options.maxBytes, options.maxBytes, "maxBytes");
  const contentLength = contentLengthFromResponse(response);
  if (contentLength !== undefined && contentLength > maxBytes) {
    const error = tooLargeError(options, contentLength, contentLength);
    abortRead(options, error);
    await response.body?.cancel(error).catch(() => {});
    throw error;
  }

  if (!response.body) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        chunks.length = 0;
        const error = tooLargeError(options, receivedBytes, contentLength);
        abortRead(options, error);
        await reader.cancel(error).catch(() => {});
        throw error;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (chunks.length === 1 && chunks[0]!.byteOffset === 0 && chunks[0]!.byteLength === chunks[0]!.buffer.byteLength) {
    return chunks[0]!;
  }

  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  chunks.length = 0;
  return body;
};

export const readJsonWithLimit = async <T = unknown>(
  response: Response,
  options: ResponseBodyLimitOptions
): Promise<T> => {
  const bytes = await readBodyWithLimit(response, options);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (error) {
    throw new ParseError("Provider response did not contain valid JSON.", { cause: error });
  }
};

export const readErrorBodyWithLimit = async (response: Response, maxBytes = DEFAULT_ERROR_BODY_BYTES) => {
  const normalizedMaxBytes = normalizePositiveLimit(maxBytes, DEFAULT_ERROR_BODY_BYTES, "errorBodyBytes");
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const remaining = normalizedMaxBytes - receivedBytes;
      if (value.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining));
          receivedBytes += remaining;
        }
        truncated = true;
        await reader.cancel("Provider error response body exceeded maximum size.").catch(() => {});
        break;
      }
      chunks.push(value);
      receivedBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const body = new TextDecoder().decode(bytes);
  return truncated ? `${body}\n...[truncated at ${normalizedMaxBytes} bytes]` : body;
};

const getBase64DecodedByteLength = (data: string) => {
  const normalized = data.trim();
  const paddingLength = normalized.length - normalized.replace(/=+$/, "").length;
  if (
    !normalized ||
    !/^[A-Za-z0-9+/_-]*={0,2}$/.test(normalized) ||
    normalized.length % 4 === 1 ||
    (paddingLength > 0 && normalized.length % 4 !== 0)
  ) {
    throw new ParseError("Provider response contained invalid base64 data.");
  }
  const withoutPadding = normalized.replace(/=+$/, "");
  return Math.floor((withoutPadding.length * 3) / 4);
};

export const decodeBase64WithLimit = (
  data: string,
  options: ResponseBodyLimitOptions
): Uint8Array => {
  const receivedBytes = getBase64DecodedByteLength(data);
  if (receivedBytes > options.maxBytes) {
    const error = tooLargeError(options, receivedBytes);
    abortRead(options, error);
    throw error;
  }
  return Uint8Array.from(Buffer.from(data.trim(), "base64"));
};
