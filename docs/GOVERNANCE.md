# Governance kit

These controls are part of the public SDK. They are the same ideas [Zhivex Harness](https://github.com/Zhivex/zhivex-harness) runs on, exposed as library calls you can adopt one at a time.

This page documents only APIs that exist in this repository. `createEgressPolicy` is public beta and marked `experimental` in the stability manifest. `createLatamSensitiveDataPolicy` is `beta`. The Latin American detectors are technical checks, not legal advice, and they are not a determination under Argentina's personal-data statute or Brazil's LGPD.

## Production preset

`createProductionSafetyPolicy()` builds a review-sensitive policy:

- credential redaction, plus email addresses;
- a budget of 6 steps, 8 tool calls, 1 tool error, and 20,000 total tokens;
- approval required for sensitive tool names.

`applySafetyPolicyToAgent()` copies that policy onto an agent definition.

```ts
import { applySafetyPolicyToAgent, createAgent, createProductionSafetyPolicy } from "@zhivex-ai/sdk";

const agent = applySafetyPolicyToAgent(createAgent({
  model,
  tools
}), createProductionSafetyPolicy());
```

`createSafetyPolicy({ preset: "permissive" | "review-sensitive" | "locked-down" })` is the lower-level builder. `createBudgetGuard()` and `createRedactionPolicy()` build the pieces separately.

## Budgets

Agent budgets live on `AgentDefinition.policy.budget` or on the production preset. Before a model or tool step, the runtime calls `evaluateAgentBudgetPreflight()`. `getAgentBudgetStatus()` reports consumption and what remains.

```ts
import { evaluateAgentBudgetPreflight, getAgentBudgetStatus } from "@zhivex-ai/sdk";

const budget = { maxSteps: 6, maxToolCalls: 8, maxToolErrors: 1, maxTotalTokens: 20_000 };
const status = getAgentBudgetStatus(state, budget);
const blocked = evaluateAgentBudgetPreflight(state, budget, { operation: "model" });
```

The gateway has a separate reservation budget. Set `GatewayConfig.budget` to `{ store, currency, reserveAmount }` from `createGatewayBudgetStore()`, and set `maxCostPer1kTokens` on a `GatewayRequest` when a route must stay under a catalog rate.

## Redaction

`createRedactionPolicy()` removes bearer tokens, basic auth, and common API-key assignments. Pass `includeEmails: true` to add email addresses. `createSensitiveDataPolicy()` is the beta alias that starts from those credential rules.

`createLatamSensitiveDataPolicy()` adds check-digit detectors. A match is replaced only when the check digit is valid, which keeps incomplete or mistyped numbers in the text. The default countries are Argentina, Brazil, Chile, and Mexico. Card numbers use the Luhn check and are included unless `includeCards: false`.

| Detector | Accepted form |
| --- | --- |
| CUIT / CUIL | Dashed `XX-XXXXXXXX-X` with a known prefix and check digit |
| CBU / CVU | 22 digits with the bank-account check digits |
| CPF | `###.###.###-##` |
| CNPJ | `##.###.###/####-##` |
| RUT | Dotted Chilean form with a hyphen |
| CURP / RFC | Official shape plus check digit |
| Card | Separators, or a bare 16-digit number, with a valid Luhn check |

Compact 11-digit CUIT strings are left alone so they are not confused with other identifiers. Repeated-digit card numbers are left alone.

```ts
import { createLatamSensitiveDataPolicy } from "@zhivex-ai/sdk";

const redaction = createLatamSensitiveDataPolicy({ countries: ["AR", "BR"] });
redaction.redactText("20-12345678-6");
```

### On generateText and streamText

Pass the policy as `redaction`. User and system text, assistant text, tool-call arguments, and tool results are redacted. Set a channel to `false` to keep it. Omit `redaction`, or pass `false`, to leave text unchanged. An empty object uses the default credential policy.

The current tool execution still receives the original model arguments. The provider request, the stream, and the returned transcript use the redacted copy. Streamed output keeps a tail long enough for the longest bounded match, and withholds the whole answer until the stream ends when a pattern is unbounded, so a later match cannot reveal a prefix. A resumed approval that must replay the original tool arguments should set `toolInputs: false`.

```ts
import { generateText } from "@zhivex-ai/sdk";

const result = await generateText({
  model,
  prompt,
  tools,
  maxSteps: 4,
  redaction
});
```

## Audit records

`createAgentAuditRecord()` and `createToolAuditRecords()` are beta projections of a finished run. They do not store the raw prompt. `createAgentRunLedger()` bundles the snapshot, trace, audit, and tool audit. Pass `egressAudit` to attach the egress decisions from the same run. The field is omitted when you do not pass it. Unknown fields, including prompts, are dropped when the ledger is normalized.

```ts
import { createAgentRunLedger } from "@zhivex-ai/sdk";

const ledger = createAgentRunLedger(state, {
  egressAudit: egressPolicy.records
});
```

## Signed tool approvals

`toolApprovalSigner` on an agent or on `generateText` signs the approval payload. `verify` is optional and is used when a stored decision is replayed.

```ts
import { createHmac } from "node:crypto";
import { createAgent } from "@zhivex-ai/sdk";

const secret = process.env.APPROVAL_SECRET;
if (!secret) throw new Error("Set APPROVAL_SECRET.");

const agent = createAgent({
  model,
  tools,
  toolApprovalSigner: {
    sign(payload) {
      return createHmac("sha256", secret).update(payload).digest("hex");
    },
    verify(payload, signature) {
      return signature === this.sign(payload);
    }
  }
});
```

## Egress allowlist

`createEgressPolicy()` is experimental. Every allow rule names a provider, a model, a region, and an endpoint. Use `*` for a dimension that may vary, including a call that does not declare a region or endpoint. An empty allow list denies every call.

`generateText` and `streamText` check the policy immediately before the provider call. The gateway checks it once per attempt, before cache lookup and before the adapter runs. A denied attempt does not fall through to another disallowed provider. An allowed later candidate can still run. When every attempt is denied, the gateway throws `EgressDeniedError`.

Each `assert` writes one `egress_call_audit` record, allowed or denied. The record stores the provider, model, declared region, canonical endpoint, and reason. It does not store the prompt. If `onAudit` throws for a denial, the call still fails with `EgressDeniedError`. If it throws for an allow, the provider is not called.

The caller declares `egress.region` and `egress.endpoint`. Provider adapters do not expose a private base URL, so the check uses that declaration. A declaration that conflicts with `providerOptions` or with a region or endpoint field on the model is denied. This check is not a replacement for `assertTrustedEndpoint`.

```ts
import { createEgressPolicy, generateText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const egressPolicy = createEgressPolicy({
  allow: [{
    provider: "openai",
    model: "gpt-6-astra",
    region: "*",
    endpoint: "api.openai.com"
  }]
});

await generateText({
  model: createOpenAI({ apiKey })("gpt-6-astra"),
  prompt,
  egressPolicy,
  egress: { endpoint: "api.openai.com" }
});
```

Import the same symbols from `@zhivex-ai/sdk/experimental` when you want the experimental boundary at the import site. `EgressDeniedError.code` is `EGRESS_DENIED`.
