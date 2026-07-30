import type { AgentApprovalRequest, ToolExecutionResult } from "./types.js";

/** @internal Carries resumable approvals discovered while a local tool is executing. */
export class ToolExecutionSuspendedError extends Error {
  constructor(
    readonly approvals: AgentApprovalRequest[],
    readonly completedResults: ToolExecutionResult[] = []
  ) {
    super("Tool execution suspended while waiting for approval.");
    this.name = "ToolExecutionSuspendedError";
  }
}
