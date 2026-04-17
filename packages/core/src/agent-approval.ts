import { providerDataPart } from "./messages.js";
import type { AgentApprovalRequest, AgentApprovalResponse, JsonValue, ModelMessage, ProviderDataPart } from "./types.js";

const isRecord = (value: JsonValue): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseApprovalRequestPart = (message: ModelMessage["parts"][number]): AgentApprovalRequest | undefined => {
  if (message.type !== "provider-data") {
    return undefined;
  }

  if (!isRecord(message.data) || message.data.type !== "mcp_approval_request") {
    return undefined;
  }

  const id = typeof message.data.id === "string" ? message.data.id : undefined;
  const name = typeof message.data.name === "string" ? message.data.name : undefined;
  const argumentsValue = typeof message.data.arguments === "string" ? message.data.arguments : undefined;

  if (!id || !name || !argumentsValue) {
    return undefined;
  }

  return {
    provider: message.provider,
    id,
    name,
    arguments: argumentsValue,
    serverLabel: typeof message.data.server_label === "string" ? message.data.server_label : undefined,
    rawData: message.data
  };
};

export const getAgentApprovalRequestFromPart = parseApprovalRequestPart;

export const getAgentApprovalRequests = (messages: ModelMessage[]): AgentApprovalRequest[] =>
  messages.flatMap((message) => message.parts.map(parseApprovalRequestPart).filter((part): part is AgentApprovalRequest => Boolean(part)));

export const agentApprovalResponsePart = (response: AgentApprovalResponse): ProviderDataPart =>
  providerDataPart(response.provider, {
    type: "mcp_approval_response",
    approval_request_id: response.approvalRequestId,
    approve: response.approve,
    ...(response.id ? { id: response.id } : {}),
    ...(response.reason ? { reason: response.reason } : {})
  }) as ProviderDataPart;

export const createAgentApprovalMessage = (responses: AgentApprovalResponse[]): ModelMessage => ({
  role: "user",
  parts: responses.map(agentApprovalResponsePart)
});
