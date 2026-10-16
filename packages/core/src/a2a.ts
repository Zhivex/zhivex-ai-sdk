/**
 * Experimental A2A 1.0 entry for Node.js and Bun.
 * Browser bundles load `a2a-browser.ts`, which keeps the client and rejects the server.
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
export { createA2aAgentServer } from "./a2a-server.js";

export type {
  A2aAgentCard,
  A2aAgentInterface,
  A2aAgentSkill,
  A2aArtifact,
  A2aMessage,
  A2aPart,
  A2aProtocolErrorCode,
  A2aRole,
  A2aStreamResponse,
  A2aTask,
  A2aTaskArtifactUpdate,
  A2aTaskState,
  A2aTaskStatus,
  A2aTaskStatusUpdate,
  AssertA2aDestinationOptions,
  CreateA2aAgentCardInput
} from "./a2a-protocol.js";
export type {
  A2aClientMessage,
  CreateRemoteA2aAgentToolOptions,
  RemoteA2aAgentOptions
} from "./a2a-client.js";
export type {
  A2aAgentCardOptions,
  A2aAgentServer,
  A2aAuthResult,
  CreateA2aAgentServerOptions
} from "./a2a-server.js";
