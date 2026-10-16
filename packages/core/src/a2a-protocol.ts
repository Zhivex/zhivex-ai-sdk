import { checkMcpDestination, McpHttpError, type McpDestinationPolicy } from "./mcp-http-common.js";
import type { JsonValue } from "./types.js";
import { isLoopbackHostname, isPrivateNetworkHostname } from "./url-security.js";

/**
 * Experimental Agent2Agent (A2A) support for the released 1.0 protocol.
 *
 * `A2A_PROTOCOL_VERSION` is the version clients and servers negotiate with the
 * `A2A-Version` header. Patch releases of the specification do not change it.
 * See https://a2a-protocol.org/latest/specification/
 */
export const A2A_PROTOCOL_VERSION = "1.0" as const;

/** Latest released specification this entrypoint targets. Negotiation still uses `1.0`. */
export const A2A_SPEC_VERSION = "1.0.0" as const;

/**
 * JSON-RPC codes from the A2A 1.0 binding, plus two implementation codes:
 * `-32000` authentication and `-32010` local limits. Both sit in the reserved
 * server-error range and are not assigned by the specification.
 */
export const A2A_JSON_RPC_ERROR = Object.freeze({
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  authRequired: -32000,
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  pushNotSupported: -32003,
  unsupported: -32004,
  contentType: -32005,
  invalidAgentResponse: -32006,
  extendedCard: -32007,
  extensionRequired: -32008,
  version: -32009,
  limitExceeded: -32010
});

export const A2A_API_STABILITY_MANIFEST = Object.freeze({
  A2A_API_STABILITY_MANIFEST: "experimental",
  A2A_PROTOCOL_VERSION: "experimental",
  A2A_SPEC_VERSION: "experimental",
  A2A_JSON_RPC_ERROR: "experimental",
  A2aProtocolError: "experimental",
  assertA2aDestination: "experimental",
  createA2aAgentCard: "experimental",
  createA2aAgentServer: "experimental",
  RemoteA2aAgent: "experimental",
  createRemoteA2aAgent: "experimental",
  createRemoteA2aAgentTool: "experimental"
} as const);

export type A2aProtocolErrorCode =
  | "AUTH_REQUIRED"
  | "CONTENT_TYPE_NOT_SUPPORTED"
  | "DESTINATION_REJECTED"
  | "INTERNAL"
  | "INVALID_PARAMS"
  | "INVALID_REQUEST"
  | "LIMIT_EXCEEDED"
  | "METHOD_NOT_FOUND"
  | "PARSE_ERROR"
  | "PROTOCOL_ERROR"
  | "PUSH_NOTIFICATIONS_NOT_SUPPORTED"
  | "TASK_NOT_CANCELABLE"
  | "TASK_NOT_FOUND"
  | "UNSUPPORTED_OPERATION"
  | "VERSION_NOT_SUPPORTED";

const JSON_RPC_CODE: Record<A2aProtocolErrorCode, number> = {
  AUTH_REQUIRED: A2A_JSON_RPC_ERROR.authRequired,
  CONTENT_TYPE_NOT_SUPPORTED: A2A_JSON_RPC_ERROR.contentType,
  DESTINATION_REJECTED: A2A_JSON_RPC_ERROR.invalidRequest,
  INTERNAL: A2A_JSON_RPC_ERROR.internal,
  INVALID_PARAMS: A2A_JSON_RPC_ERROR.invalidParams,
  INVALID_REQUEST: A2A_JSON_RPC_ERROR.invalidRequest,
  LIMIT_EXCEEDED: A2A_JSON_RPC_ERROR.limitExceeded,
  METHOD_NOT_FOUND: A2A_JSON_RPC_ERROR.methodNotFound,
  PARSE_ERROR: A2A_JSON_RPC_ERROR.parse,
  PROTOCOL_ERROR: A2A_JSON_RPC_ERROR.internal,
  PUSH_NOTIFICATIONS_NOT_SUPPORTED: A2A_JSON_RPC_ERROR.pushNotSupported,
  TASK_NOT_CANCELABLE: A2A_JSON_RPC_ERROR.taskNotCancelable,
  TASK_NOT_FOUND: A2A_JSON_RPC_ERROR.taskNotFound,
  UNSUPPORTED_OPERATION: A2A_JSON_RPC_ERROR.unsupported,
  VERSION_NOT_SUPPORTED: A2A_JSON_RPC_ERROR.version
};

/** Stable machine-readable A2A failure. Messages never include payloads, URLs, or credentials. */
export class A2aProtocolError extends Error {
  readonly name = "A2aProtocolError";
  readonly jsonRpcCode: number;

  constructor(readonly code: A2aProtocolErrorCode, message: string) {
    super(message);
    this.jsonRpcCode = JSON_RPC_CODE[code];
  }
}

export type A2aTaskState =
  | "TASK_STATE_AUTH_REQUIRED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_REJECTED"
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_UNSPECIFIED"
  | "TASK_STATE_WORKING";

export type A2aRole = "ROLE_AGENT" | "ROLE_USER";

export interface A2aPart {
  text?: string;
  data?: JsonValue;
  raw?: string;
  url?: string;
  mediaType?: string;
  filename?: string;
  metadata?: Record<string, JsonValue>;
}

export interface A2aMessage {
  messageId: string;
  role: A2aRole;
  parts: A2aPart[];
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, JsonValue>;
}

export interface A2aArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2aPart[];
}

export interface A2aTaskStatus {
  state: A2aTaskState;
  timestamp?: string;
  message?: A2aMessage;
}

export interface A2aTask {
  id: string;
  contextId: string;
  status: A2aTaskStatus;
  artifacts?: A2aArtifact[];
  history?: A2aMessage[];
}

export interface A2aTaskStatusUpdate {
  taskId: string;
  contextId: string;
  status: A2aTaskStatus;
}

export interface A2aTaskArtifactUpdate {
  taskId: string;
  contextId: string;
  artifact: A2aArtifact;
  append?: boolean;
  lastChunk?: boolean;
}

/** StreamResponse object from the 1.0 JSON-RPC binding. Exactly one member is set. */
export interface A2aStreamResponse {
  task?: A2aTask;
  message?: A2aMessage;
  statusUpdate?: A2aTaskStatusUpdate;
  artifactUpdate?: A2aTaskArtifactUpdate;
}

export interface A2aAgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface A2aAgentInterface {
  url: string;
  protocolBinding: string;
  protocolVersion: string;
  tenant?: string;
}

export interface A2aAgentCard {
  name: string;
  description: string;
  supportedInterfaces: A2aAgentInterface[];
  version: string;
  capabilities: {
    streaming?: boolean;
    pushNotifications?: boolean;
    extendedAgentCard?: boolean;
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2aAgentSkill[];
  documentationUrl?: string;
}

export interface CreateA2aAgentCardInput {
  name: string;
  description: string;
  url: string;
  version?: string;
  skills?: A2aAgentSkill[];
  documentationUrl?: string;
}

export interface AssertA2aDestinationOptions {
  /** Same callback shape as MCP HTTP destination policy. Invoked with purpose `"server"`. */
  destinationPolicy?: McpDestinationPolicy;
  /**
   * Permit `http:` and `https:` loopback targets for in-process tests.
   * Private, link-local, and metadata hosts stay rejected.
   */
  allowLoopbackHttp?: boolean;
}

const IDENTIFIER = /^[A-Za-z0-9_][A-Za-z0-9._:-]{0,127}$/;
const TERMINAL_STATES = new Set<A2aTaskState>([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED"
]);

export const A2A_TASK_INDEX_SESSION_ID = "a2a_task_index";

export const isTerminalA2aState = (state: A2aTaskState): boolean => TERMINAL_STATES.has(state);

export const createA2aId = (prefix: string): string => {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new A2aProtocolError("INTERNAL", "Secure IDs require Web Crypto randomUUID.");
  }
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
};

export const isA2aIdentifier = (value: string): boolean => IDENTIFIER.test(value);

const canonicalMethods: Record<string, string> = {
  SendMessage: "SendMessage",
  SendStreamingMessage: "SendStreamingMessage",
  GetTask: "GetTask",
  CancelTask: "CancelTask",
  // Operation aliases from the pre-1.0 JSON-RPC method names. Normative wire
  // names remain the PascalCase methods in the 1.0 binding.
  "message/send": "SendMessage",
  "message/stream": "SendStreamingMessage",
  "tasks/get": "GetTask",
  "tasks/cancel": "CancelTask"
};

const pushMethods = new Set([
  "CreateTaskPushNotificationConfig",
  "GetTaskPushNotificationConfig",
  "ListTaskPushNotificationConfigs",
  "DeleteTaskPushNotificationConfig",
  "tasks/pushNotificationConfig/set",
  "tasks/pushNotificationConfig/get",
  "tasks/pushNotificationConfig/list",
  "tasks/pushNotificationConfig/delete"
]);

export const canonicalA2aMethod = (method: string): string => {
  if (pushMethods.has(method)) {
    throw new A2aProtocolError("PUSH_NOTIFICATIONS_NOT_SUPPORTED", "Push notifications are not supported.");
  }
  if (method === "GetExtendedAgentCard" || method === "agent/getAuthenticatedExtendedCard") {
    throw new A2aProtocolError("UNSUPPORTED_OPERATION", "Extended agent cards are not supported.");
  }
  if (method === "ListTasks" || method === "tasks/list" || method === "SubscribeToTask" || method === "tasks/resubscribe") {
    throw new A2aProtocolError("UNSUPPORTED_OPERATION", "This A2A operation is not implemented.");
  }
  const canonical = canonicalMethods[method];
  if (!canonical) {
    throw new A2aProtocolError("METHOD_NOT_FOUND", "Method not found.");
  }
  return canonical;
};

export const createA2aAgentCard = (input: CreateA2aAgentCardInput): A2aAgentCard => {
  const name = requiredText(input.name, "Card name");
  const description = requiredText(input.description, "Card description");
  const skills = input.skills?.length
    ? input.skills.map(normalizeSkill)
    : [{
      id: "general",
      name,
      description,
      tags: ["general"]
    }];
  return {
    name,
    description,
    supportedInterfaces: [{
      url: input.url,
      protocolBinding: "JSONRPC",
      protocolVersion: A2A_PROTOCOL_VERSION
    }],
    version: input.version ?? "0.0.0-experimental",
    capabilities: { streaming: true },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills,
    ...(input.documentationUrl ? { documentationUrl: input.documentationUrl } : {})
  };
};

const normalizeSkill = (skill: A2aAgentSkill): A2aAgentSkill => ({
  id: requiredText(skill.id, "Skill id"),
  name: requiredText(skill.name, "Skill name"),
  description: requiredText(skill.description, "Skill description"),
  tags: skill.tags?.length ? skill.tags.map((tag) => requiredText(tag, "Skill tag")) : ["general"]
});

const requiredText = (value: string, label: string): string => {
  if (typeof value !== "string" || value.trim() === "" || value.length > 500) {
    throw new A2aProtocolError("INVALID_PARAMS", `${label} is invalid.`);
  }
  return value;
};

/**
 * Rejects non-HTTPS, credentialed, private, link-local, and metadata destinations.
 * Loopback HTTP is allowed only when the caller opts in for a local test server.
 * Public HTTPS destinations still pass through `checkMcpDestination`.
 */
export const assertA2aDestination = async (
  value: string | URL,
  options: AssertA2aDestinationOptions = {}
): Promise<URL> => {
  let parsed: URL;
  try {
    parsed = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    throw new A2aProtocolError("DESTINATION_REJECTED", "A2A destination rejected by policy.");
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new A2aProtocolError("DESTINATION_REJECTED", "A2A destination rejected by policy.");
  }
  const loopback = options.allowLoopbackHttp === true &&
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    isLoopbackHostname(parsed.hostname);
  try {
    if (loopback) {
      if (options.destinationPolicy && !await options.destinationPolicy(new URL(parsed.href), "server")) {
        throw new A2aProtocolError("DESTINATION_REJECTED", "A2A destination rejected by policy.");
      }
      return parsed;
    }
    await checkMcpDestination(parsed, "server", options.destinationPolicy);
  } catch (error) {
    if (error instanceof A2aProtocolError) throw error;
    if (error instanceof McpHttpError || error instanceof Error) {
      throw new A2aProtocolError("DESTINATION_REJECTED", "A2A destination rejected by policy.");
    }
    throw new A2aProtocolError("DESTINATION_REJECTED", "A2A destination rejected by policy.");
  }
  if (isPrivateNetworkHostname(parsed.hostname) || isLoopbackHostname(parsed.hostname)) {
    throw new A2aProtocolError("DESTINATION_REJECTED", "A2A destination rejected by policy.");
  }
  return parsed;
};

export const httpStatusForA2aCode = (code: number): number => {
  if (code === A2A_JSON_RPC_ERROR.authRequired) return 401;
  if (code === A2A_JSON_RPC_ERROR.taskNotFound || code === A2A_JSON_RPC_ERROR.methodNotFound) return 404;
  if (code === A2A_JSON_RPC_ERROR.internal || code === A2A_JSON_RPC_ERROR.invalidAgentResponse) return 500;
  if (code === A2A_JSON_RPC_ERROR.parse || code === A2A_JSON_RPC_ERROR.invalidRequest || code === A2A_JSON_RPC_ERROR.invalidParams) {
    return 400;
  }
  if (code <= -32001 && code >= -32099) return 400;
  return 500;
};

export const supportedA2aVersion = (header: string | undefined): boolean => {
  if (header === undefined) return false;
  const value = header.trim();
  return value.length <= 16 && value === A2A_PROTOCOL_VERSION;
};
