import type { AgentApprovalRequest } from "@zhivex-ai/core";

export const approvalKey = (
  approval: Pick<AgentApprovalRequest, "provider" | "id">
) => JSON.stringify([approval.provider, approval.id]);

export const selectPendingApproval = (
  approvals: readonly AgentApprovalRequest[],
  approvalRequestId: string,
  provider?: string
): AgentApprovalRequest => {
  const matches = approvals.filter(
    (approval) =>
      approval.id === approvalRequestId &&
      (provider === undefined || approval.provider === provider)
  );
  if (matches.length === 0) {
    throw new Error(`Unknown approval request "${approvalRequestId}".`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Approval request "${approvalRequestId}" is ambiguous; provide its provider.`
    );
  }
  return matches[0]!;
};
