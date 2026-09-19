/** Server-side adapter helpers. No agent orchestration, stores, or default catalog. */
export {
  ConfigurationError,
  ParseError,
  ProviderHTTPError,
  ProviderResponseTooLargeError,
  ProviderToolCallError,
  UnsupportedFeatureError,
  ValidationError
} from "./errors.js";
export {
  normalizeMessages
} from "./normalize-messages.js";
export {
  withResponseRetry
} from "./http-retry.js";
export {
  createMcpToolSet
} from "./mcp.js";
export {
  hostedTool,
  isCallableToolDefinition,
  isHostedToolDefinition,
  normalizeFinishReason,
  providerDataPart,
  serializeJsonValue,
  tool
} from "./messages.js";
export {
  CallbackRealtimeSession,
  encodeAudioFrame,
  encodeMediaFrame,
  openWebSocketConnection,
  toolResultPayload,
  unsupportedBrowserToken
} from "./realtime.js";
export {
  decodeBase64WithLimit,
  readBodyWithLimit,
  readErrorBodyWithLimit,
  readJsonWithLimit,
  resolveAudioResponseLimits
} from "./response.js";
export {
  createMergedAbortSignal,
  createProviderAdapter,
  withRetry,
  withTimeoutSignal
} from "./runtime.js";
export {
  streamSSE
} from "./stream.js";
export {
  toToolSet
} from "./tool-registry.js";
export {
  assertTrustedEndpoint,
  isLoopbackHostname
} from "./url-security.js";
export type * from "./types.js";
export type { AudioResponseLimits } from "./response.js";
export type * from "./mcp.js";
export type * from "./realtime.js";

export { imageInputToDataUrl } from "./image-input.js";

export { createChatCompletionsModel } from "./chat-completions.js";
export type { ChatCompletionsTransportOptions } from "./chat-completions.js";
