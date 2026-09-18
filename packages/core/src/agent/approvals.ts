import {
  createAgentApprovalMessage
} from "../agent-approval.js";
import {
  ValidationError
} from "../errors.js";
import type {
  AgentApprovalResolution,
  AgentApprovalResponse,
  AgentDefinition,
  AgentRunState,
  ModelMessage
} from "../types.js";

const localApprovalResolutionPayload = (
  inputDigest: string,
  approve: boolean,
  reason?: string
): string => JSON.stringify({
  inputDigest,
  approve,
  reason: reason ?? null
});

const approvalKey = (provider: string, requestId: string) => `${provider}\0${requestId}`;

export const applyApprovalResponses = async (
  messages: ModelMessage[],
  approvals: AgentApprovalResponse[] | undefined,
  pendingApprovals: AgentRunState["pendingApprovals"],
  approvalHistory: AgentRunState["approvalHistory"] = [],
  signer?: AgentDefinition["toolApprovalSigner"]
) => {
  if (!approvals?.length) {
    return {
      messages,
      pendingApprovals,
      approvalHistory
    };
  }

  const pendingById = new Map(
    pendingApprovals.map((approval) => [approvalKey(approval.provider, approval.id), approval])
  );
  for (const approval of approvals) {
    const pending = pendingById.get(approvalKey(approval.provider, approval.approvalRequestId));
    if (!pending) {
      throw new ValidationError(
        `Unknown approval request "${approval.approvalRequestId}" for provider "${approval.provider}".`
      );
    }
  }

  const providerApprovals = approvals.filter((approval) => {
    const pending = pendingById.get(approvalKey(approval.provider, approval.approvalRequestId));
    return pending?.kind === undefined || pending.kind === "provider";
  });
  const localResolutions: AgentApprovalResolution[] = [];
  const subagentResolutions: AgentApprovalResolution[] = [];
  for (const approval of approvals) {
    const pending = pendingById.get(approvalKey(approval.provider, approval.approvalRequestId));
    if (!pending) {
      continue;
    }
    if (pending.kind === "subagent") {
      subagentResolutions.push({
        requestId: pending.id,
        kind: "subagent",
        provider: pending.provider,
        approve: approval.approve,
        reason: approval.reason,
        toolCallId: pending.toolCallId,
        childRunId: pending.childRunId,
        childAgentId: pending.childAgentId,
        childApprovalRequestId: pending.childApprovalRequestId,
        resolvedAt: Date.now()
      });
      continue;
    }
    if (pending.kind !== "local-tool") {
      continue;
    }
    if (signer) {
      if (!pending.inputDigest || !pending.signature) {
        throw new ValidationError(`Approval request "${pending.id}" is missing its required signature.`);
      }
      const requestSignatureValid = signer.verify
        ? await signer.verify(pending.inputDigest, pending.signature)
        : (await signer.sign(pending.inputDigest)) === pending.signature;
      if (!requestSignatureValid) {
        throw new ValidationError(`Approval request "${pending.id}" has an invalid signature.`);
      }
    }
    const resolutionSignature =
      signer && pending.inputDigest
        ? await signer.sign(
            localApprovalResolutionPayload(
              pending.inputDigest,
              approval.approve,
              approval.reason
            )
          )
        : undefined;
    localResolutions.push({
      requestId: pending.id,
      kind: "local-tool",
      provider: pending.provider,
      approve: approval.approve,
      reason: approval.reason,
      toolCallId: pending.toolCallId,
      step: pending.step,
      inputDigest: pending.inputDigest,
      toolVersion: pending.toolVersion,
      signature: resolutionSignature,
      resolvedAt: Date.now()
    });
  }

  return {
    messages: providerApprovals.length
      ? [...messages, createAgentApprovalMessage(providerApprovals)]
      : messages,
    pendingApprovals: pendingApprovals.filter(
      (pending) => !approvals.some(
        (approval) =>
          approval.approvalRequestId === pending.id &&
          approval.provider === pending.provider
      )
    ),
    approvalHistory: [
      ...approvalHistory.filter(
        (existing) =>
          !localResolutions.some(
            (resolution) =>
              resolution.requestId === existing.requestId &&
              resolution.provider === existing.provider
          ) &&
          !subagentResolutions.some(
            (resolution) =>
              resolution.requestId === existing.requestId &&
              resolution.provider === existing.provider
          )
      ),
      ...localResolutions,
      ...subagentResolutions
    ]
  };
};
