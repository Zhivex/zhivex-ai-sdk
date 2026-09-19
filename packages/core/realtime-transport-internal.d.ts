export declare const openAuthenticatedWebSocketConnection: (
  url: string,
  headers: Record<string, string>,
  options?: { signal?: AbortSignal; timeoutMs?: number; subprotocols?: string[]; maxIncomingFrameBytes?: number }
) => Promise<{
  sendJson(payload: Record<string, unknown>): Promise<void>;
  recvJson(): Promise<unknown>;
  close(): Promise<void>;
}>;
