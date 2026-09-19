import { ConfigurationError } from "./errors.js";
import type { RealtimeConnectionFactory } from "./realtime.js";

export const openAuthenticatedWebSocketConnection: RealtimeConnectionFactory = async () => {
  throw new ConfigurationError('Browser WebSocket connections do not support custom headers. Provide a "realtimeConnectionFactory" from your runtime when auth headers are required.');
};
