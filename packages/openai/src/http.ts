import { ProviderHTTPError, readErrorBodyWithLimit, readJsonWithLimit } from "@zhivex-ai/core/provider";

export const jsonHeaders = (apiKey: string) => ({
  "content-type": "application/json",
  authorization: `Bearer ${apiKey}`
});

const OPENAI_JSON_RESPONSE_MAX_BYTES = 128 * 1024 * 1024;
export const RESERVED_REQUEST_HEADERS = new Set([
  "authorization",
  "content-type",
  "content-length",
  "host",
  "connection",
  "transfer-encoding"
]);

export const parseJson = async (
  response: Response,
  options: {
    maxBytes?: number;
    errorBodyBytes?: number;
    provider?: string;
    endpoint?: string;
    abort?: (reason?: unknown) => void;
  } = {}
) => {
  if (!response.ok) {
    const body = await readErrorBodyWithLimit(response, options.errorBodyBytes);
    throw new ProviderHTTPError(`OpenAI request failed with status ${response.status}.`, response.status, {
      responseBody: body
    });
  }
  return readJsonWithLimit<any>(response, {
    maxBytes: options.maxBytes ?? OPENAI_JSON_RESPONSE_MAX_BYTES,
    provider: options.provider ?? "openai",
    endpoint: options.endpoint,
    abort: options.abort
  });
};

