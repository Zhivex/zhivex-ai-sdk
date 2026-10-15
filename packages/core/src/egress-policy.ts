import { randomUUID } from "node:crypto";

import {
  type EgressAllowRule,
  type EgressAuditRecord,
  type EgressCallTarget,
  type EgressDeclaration,
  type EgressPolicy,
  type EgressPolicyOptions
} from "./egress-types.js";
import { ValidationError, ZhivexAIError } from "./errors.js";
import { PRODUCTION_AGENT_KIT_SCHEMA_VERSION } from "./production-agent-kit.js";

export type {
  EgressAllowRule,
  EgressAuditRecord,
  EgressCallTarget,
  EgressDeclaration,
  EgressPolicy,
  EgressPolicyOptions
} from "./egress-types.js";

/** Public beta. The stability manifest marks this API experimental. */
export const EGRESS_WILDCARD = "*" as const;

export class EgressDeniedError extends ZhivexAIError {
  readonly code = "EGRESS_DENIED" as const;
  readonly provider: string;
  readonly modelId: string;
  readonly region?: string;
  readonly endpoint?: string;
  readonly audit: EgressAuditRecord;

  constructor(audit: EgressAuditRecord, options?: { cause?: unknown }) {
    super(`Egress denied for ${audit.provider}/${audit.modelId}: ${audit.reason}`, options);
    this.provider = audit.provider;
    this.modelId = audit.modelId;
    this.region = audit.region;
    this.endpoint = audit.endpoint;
    this.audit = audit;
  }
}

interface NormalizedEndpoint {
  kind: "any" | "host" | "url";
  host?: string;
  protocol?: string;
  port?: string;
  path?: string;
  /** Canonical value stored on the audit record. */
  canonical?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const tryNormalizeEndpoint = (value: string): { ok: true; endpoint: NormalizedEndpoint } | { ok: false; reason: string } => {
  if (value === EGRESS_WILDCARD) {
    return { ok: true, endpoint: { kind: "any", canonical: EGRESS_WILDCARD } };
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { ok: false, reason: "endpoint is not a valid URL" };
    }
    if (url.username || url.password) {
      return { ok: false, reason: "endpoint must not include credentials" };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { ok: false, reason: "endpoint must use http or https" };
    }
    const path = url.pathname.replace(/\/$/, "");
    const canonical = `${url.origin}${path}`;
    return {
      ok: true,
      endpoint: {
        kind: "url",
        host: url.hostname.toLowerCase(),
        protocol: url.protocol,
        port: url.port,
        path,
        canonical
      }
    };
  }

  if (!/^[a-z0-9.-]+$/i.test(value) || value.startsWith(".") || value.endsWith(".")) {
    return { ok: false, reason: "endpoint must be a hostname, an absolute http(s) URL, or *" };
  }

  const host = value.toLowerCase();
  return { ok: true, endpoint: { kind: "host", host, canonical: host } };
};

const normalizeRuleEndpoint = (value: string): NormalizedEndpoint => {
  const normalized = tryNormalizeEndpoint(value);
  if (!normalized.ok) {
    throw new ValidationError(`Egress allow rule ${normalized.reason}.`);
  }
  return normalized.endpoint;
};

const endpointMatches = (rule: NormalizedEndpoint, call: NormalizedEndpoint | undefined): boolean => {
  if (rule.kind === "any") {
    return true;
  }
  if (!call || call.kind === "any") {
    return false;
  }
  if (rule.host !== call.host) {
    return false;
  }
  if (rule.kind === "host") {
    return true;
  }
  if (call.kind !== "url" || rule.protocol !== call.protocol || (rule.port ?? "") !== (call.port ?? "")) {
    return false;
  }
  if (!rule.path) {
    return true;
  }
  return call.path === rule.path || Boolean(call.path?.startsWith(`${rule.path}/`));
};

const dimensionMatches = (ruleValue: string, callValue: string | undefined, caseInsensitive = false): boolean => {
  if (ruleValue === EGRESS_WILDCARD) {
    return true;
  }
  if (!callValue) {
    return false;
  }
  return caseInsensitive ? ruleValue.toLowerCase() === callValue.toLowerCase() : ruleValue === callValue;
};

const requireRuleField = (rule: EgressAllowRule, field: keyof EgressAllowRule): string => {
  const value = rule[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError(`Egress allow rule ${field} must be a non-empty string or "*".`);
  }
  return value.trim();
};

const compileRule = (rule: EgressAllowRule) => ({
  provider: requireRuleField(rule, "provider"),
  model: requireRuleField(rule, "model"),
  region: requireRuleField(rule, "region"),
  endpoint: normalizeRuleEndpoint(requireRuleField(rule, "endpoint"))
});

const auditEndpoint = (endpoint: NormalizedEndpoint | undefined): string | undefined =>
  endpoint && endpoint.kind !== "any" ? endpoint.canonical : undefined;

const auditors = new WeakMap<EgressPolicy, EgressPolicyOptions["onAudit"]>();

const writeAudit = async (policy: EgressPolicy, record: EgressAuditRecord): Promise<void> => {
  policy.records.push(record);
  try {
    await auditors.get(policy)?.(record);
  } catch (error) {
    if (record.decision === "denied") {
      throw new EgressDeniedError(record, { cause: error });
    }
    throw error;
  }
};

export const createEgressPolicy = (options: EgressPolicyOptions): EgressPolicy => {
  if (!options || !Array.isArray(options.allow)) {
    throw new ValidationError("Egress policy allow must be an array.");
  }

  const allow = options.allow.map(compileRule);
  const records: EgressAuditRecord[] = [];
  const policy: EgressPolicy = {
    allow: options.allow.map((rule) => ({
      provider: rule.provider.trim(),
      model: rule.model.trim(),
      region: rule.region.trim(),
      endpoint: normalizeRuleEndpoint(rule.endpoint.trim()).canonical ?? rule.endpoint.trim()
    })),
    records,
    async assert(target) {
      const provider = readString(target.provider) ?? "";
      const model = readString(target.model) ?? "";
      const region = readString(target.region);
      const endpointResult = target.endpoint === undefined ? undefined : tryNormalizeEndpoint(target.endpoint.trim());
      const endpoint = endpointResult?.ok ? endpointResult.endpoint : undefined;
      let decision: EgressAuditRecord["decision"] = "denied";
      let reason = "no allow rule matched";

      if (!provider || !model) {
        reason = "provider and model are required";
      } else if (endpointResult && !endpointResult.ok) {
        reason = endpointResult.reason;
      } else if (allow.length === 0) {
        reason = "allowlist is empty";
      } else {
        const match = allow.find((rule) =>
          dimensionMatches(rule.provider, provider) &&
          dimensionMatches(rule.model, model) &&
          dimensionMatches(rule.region, region, true) &&
          endpointMatches(rule.endpoint, endpoint)
        );
        if (match) {
          decision = "allowed";
          reason = "allow rule matched";
        }
      }

      const record: EgressAuditRecord = {
        schemaVersion: PRODUCTION_AGENT_KIT_SCHEMA_VERSION,
        type: "egress_call_audit",
        id: randomUUID(),
        decision,
        provider: provider || "unknown",
        modelId: model || "unknown",
        region,
        endpoint: auditEndpoint(endpoint),
        reason,
        createdAt: Date.now()
      };
      await writeAudit(policy, record);
      if (decision === "denied") {
        throw new EgressDeniedError(record);
      }
      return record;
    }
  };
  auditors.set(policy, options.onAudit);

  return policy;
};

const readProviderString = (providerOptions: unknown, keys: readonly string[]): string | undefined => {
  if (!isRecord(providerOptions)) {
    return undefined;
  }
  for (const key of keys) {
    const value = readString(providerOptions[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
};

const readModelString = (model: object, keys: readonly string[]): string | undefined => {
  const record = model as Record<string, unknown>;
  for (const key of keys) {
    const value = readString(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
};

export interface ResolvedEgressTarget {
  target: EgressCallTarget;
  conflict?: string;
}

/** Resolves the declared target. A conflict fails closed before any provider call. */
export const resolveEgressTarget = (
  model: { provider: string; modelId: string },
  declaration: EgressDeclaration | undefined,
  providerOptions: unknown
): ResolvedEgressTarget => {
  const declaredRegion = readString(declaration?.region);
  const optionRegion = readProviderString(providerOptions, ["region", "location"]);
  const modelRegion = readModelString(model, ["region", "egressRegion"]);
  const declaredEndpoint = readString(declaration?.endpoint);
  const optionEndpoint = readProviderString(providerOptions, ["endpoint", "baseURL", "baseUrl"]);
  const modelEndpoint = readModelString(model, ["endpoint", "baseURL", "baseUrl", "egressEndpoint"]);

  const regionSources = [declaredRegion, optionRegion, modelRegion].filter((value): value is string => Boolean(value));
  const endpointSources = [declaredEndpoint, optionEndpoint, modelEndpoint].filter((value): value is string => Boolean(value));
  const unique = (values: string[], caseInsensitive: boolean) => {
    const seen = new Set<string>();
    for (const value of values) {
      seen.add(caseInsensitive ? value.toLowerCase() : value);
    }
    return seen.size;
  };

  if (unique(regionSources, true) > 1) {
    return {
      target: { provider: model.provider, model: model.modelId, region: declaredRegion ?? optionRegion ?? modelRegion },
      conflict: "declared region does not match the model region"
    };
  }
  if (unique(endpointSources.map((value) => {
    const normalized = tryNormalizeEndpoint(value);
    return normalized.ok ? (normalized.endpoint.canonical ?? value) : value;
  }), false) > 1) {
    return {
      target: {
        provider: model.provider,
        model: model.modelId,
        region: regionSources[0],
        endpoint: declaredEndpoint ?? optionEndpoint ?? modelEndpoint
      },
      conflict: "declared endpoint does not match the model endpoint"
    };
  }

  return {
    target: {
      provider: model.provider,
      model: model.modelId,
      region: regionSources[0],
      endpoint: endpointSources[0]
    }
  };
};

export const enforceEgressPolicy = async (
  policy: EgressPolicy,
  model: { provider: string; modelId: string },
  declaration: EgressDeclaration | undefined,
  providerOptions: unknown
): Promise<EgressAuditRecord> => {
  const resolved = resolveEgressTarget(model, declaration, providerOptions);
  if (resolved.conflict) {
    const normalized = resolved.target.endpoint ? tryNormalizeEndpoint(resolved.target.endpoint) : undefined;
    const record: EgressAuditRecord = {
      schemaVersion: PRODUCTION_AGENT_KIT_SCHEMA_VERSION,
      type: "egress_call_audit",
      id: randomUUID(),
      decision: "denied",
      provider: model.provider,
      modelId: model.modelId,
      region: resolved.target.region,
      endpoint: normalized?.ok ? auditEndpoint(normalized.endpoint) : undefined,
      reason: resolved.conflict,
      createdAt: Date.now()
    };
    await writeAudit(policy, record);
    throw new EgressDeniedError(record);
  }
  return policy.assert(resolved.target);
};
