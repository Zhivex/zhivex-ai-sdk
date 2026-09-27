/**
 * Compatibility alias for the stable control-plane entry point plus the
 * remaining beta governance helpers.
 *
 * @deprecated Import stable control-plane contracts from "./control-plane".
 */
export * from "./control-plane.js";

export {
  PRODUCTION_AGENT_KIT_SCHEMA_VERSION,
  createAgentExecutionEnvironmentBinding,
  createAgentHarnessBinding,
  createAgentAuditRecord,
  createReadOnlyToolApprovalPolicy,
  createSensitiveDataPolicy,
  createToolAuditRecords,
  fingerprintAgentHarness,
  getAgentCapabilities,
  getAgentSupportTier,
  getHostedToolClass
} from "@zhivex-ai/core/beta";

export type {
  AgentAuditRecord,
  AgentAuditRecordOptions,
  ReadOnlyToolApprovalPolicyOptions,
  SensitiveDataPolicyOptions,
  ToolAuditRecord,
  ToolAuditRecordOptions
} from "@zhivex-ai/core/beta";

export { reconcileAgentToolExecution } from "@zhivex-ai/core/beta";
export type { ReconcileAgentToolExecutionOptions, AgentToolReconciliationEvidence, AgentToolReconciliationRecord } from "@zhivex-ai/core/beta";

export { createAgentBudgetCoordinator } from "@zhivex-ai/core/beta";
export type { AgentBudgetCoordinator, AgentBudgetCoordinatorOptions, AgentTokenReservation } from "@zhivex-ai/core/beta";
