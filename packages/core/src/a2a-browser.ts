/**
 * Browser entry for experimental A2A. The JSON-RPC client is portable.
 * The HTTP server binds a socket and stays on Node.js and Bun.
 */
export {
  A2A_API_STABILITY_MANIFEST,
  A2A_JSON_RPC_ERROR,
  A2A_PROTOCOL_VERSION,
  A2A_SPEC_VERSION,
  A2aProtocolError,
  assertA2aDestination,
  createA2aAgentCard
} from "./a2a-protocol.js";
export {
  RemoteA2aAgent,
  createRemoteA2aAgent,
  createRemoteA2aAgentTool
} from "./a2a-client.js";

import { A2aProtocolError } from "./a2a-protocol.js";

export const createA2aAgentServer = (): never => {
  throw new A2aProtocolError("UNSUPPORTED_OPERATION", "The A2A server is available only on Node.js and Bun.");
};
