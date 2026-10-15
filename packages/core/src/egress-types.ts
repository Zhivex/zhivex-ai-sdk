/** Public beta shapes. The stability manifest marks the runtime API experimental. */

export interface EgressAllowRule {
  /** Provider id, or `*` for any provider. */
  provider: string;
  /** Model id, or `*` for any model. */
  model: string;
  /** Region, or `*` for any region, including a call that does not declare one. */
  region: string;
  /** Hostname, absolute http(s) URL, or `*`. */
  endpoint: string;
}

export interface EgressDeclaration {
  region?: string;
  endpoint?: string;
}

export interface EgressCallTarget {
  provider: string;
  model: string;
  region?: string;
  endpoint?: string;
}

export interface EgressAuditRecord {
  schemaVersion: 1;
  type: "egress_call_audit";
  id: string;
  decision: "allowed" | "denied";
  provider: string;
  modelId: string;
  region?: string;
  endpoint?: string;
  reason: string;
  createdAt: number;
}

export interface EgressPolicyOptions {
  /** Fail closed. An empty list denies every call. */
  allow: readonly EgressAllowRule[];
  /** Invoked once for every decision. A throw prevents the provider call. */
  onAudit?: (record: EgressAuditRecord) => void | Promise<void>;
}

export interface EgressPolicy {
  readonly allow: readonly EgressAllowRule[];
  /** One record per `assert` call, whether the call was allowed or denied. */
  readonly records: EgressAuditRecord[];
  assert(target: EgressCallTarget): Promise<EgressAuditRecord>;
}
