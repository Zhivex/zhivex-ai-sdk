# Qwen Cloud Decision Preview

`decision-model-preview` uses the provider-native `decisionModel().decide()` extension. It is not a chat model. Its System One protocol evaluates business state against typed questions and returns probabilities rather than generated text.

```ts
import { createQwen, QWEN_CLOUD_BASE_URL } from "@zhivex-ai/qwen";

const qwen = createQwen({
  baseURL: QWEN_CLOUD_BASE_URL,
  apiKey: process.env.QWEN_API_KEY,
  // Explicit trial endpoint from the official Decision API example.
  decisionBaseURL: "https://trial.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"
});
const result = await qwen.decisionModel("decision-model-preview").decide({
  state: { ticket: "Customer requests a refund." },
  questions: {
    route: {
      type: "choice",
      instructions: "Choose the responsible team.",
      criteria: { billing: "Payments and refunds", technical: "Product faults" }
    },
    urgent: { type: "noul", instructions: "Does this require urgent attention?" },
    severity: {
      type: "score",
      instructions: "Rate the issue severity.",
      criteria: ["Minor", "Core function unavailable", "Severe impact"]
    }
  },
  timeoutMs: 15_000,
  maxRetries: 0
});
console.log(result.answers.route.choice, result.answers.route.probabilities);
console.log(result.answers.urgent.noul, result.answers.severity.score);
```

## Contract

- `choice` carries a named criteria map and returns a selected key, probability distribution and confidence.
- `noul` returns a probability in `[0, 1]`; the SDK preserves that number without inventing a threshold or converting it to a boolean.
- `score` carries ordered criteria and returns a fractional score, indexed distribution, matching legend and confidence.
- Results include `requestId`, `usage.inputTokens` and server-reported `latencyMs`. Server latency excludes network overhead.

Question and answer keys/types, distributions, numeric ranges, legends, usage and model identity are validated. Responses and requests are bounded to 1 MiB. Credentials require HTTPS and a public endpoint by default, redirects are rejected, and errors do not retain server bodies that might echo business state. The SDK defaults to no retries for this billable inference. Explicit `maxRetries` uses the shared retry policy. Timeout defaults to 30 seconds.

Streaming, function calling and generated structured output do not apply. Evaluate task accuracy and probability calibration on representative examples before selecting application thresholds. The extension does not turn predictions into deterministic business rules.

## Validation evidence

Verified September 26, 2026:

- Contract suite: 19 passing tests, including malformed answers, invalid questions, response bounds, credential endpoint validation, cancellation and explicit retries.
- One short authenticated request covering all three question types passed against the documented trial endpoint, with no retries.
- The standard `https://maas.qwencloudapi.com/compatible-mode/v1/systemone` route returned HTTP 404 with the available account. Endpoint availability is therefore separate from SDK implementation; configure `decisionBaseURL` explicitly for the trial service.

The opt-in live test never runs in the default suite:

```bash
QWEN_DECISION_LIVE=1 \
QWEN_DECISION_BASE_URL=https://trial.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1 \
bun --env-file=.env run node_modules/vitest/vitest.mjs run packages/qwen/tests/decision.live.test.ts
```

It performs one tiny inference with `QWEN_API_KEY` or `DASHSCOPE_API_KEY` and zero retries. Pricing is not assumed or estimated.

Source: [Qwen Cloud Decision API](https://docs.qwencloud.com/api-reference/decision-model-api). The documented schema labels `state` as a string while its example sends an object; the SDK supports both, and the live test verified a string state.

## Small comparison with Qwen 3.8 Flash

A six-request live evaluation used three synthetic tickets (refund, production outage, sales quote). Both models selected the expected team and urgency in all three cases. This sample is illustrative, not an accuracy or calibration benchmark. Flash ran with thinking disabled and a 100-token output limit; all requests used zero retries.

| Case | Decision wall / server ms | Decision input tokens | Flash wall ms | Flash input / output tokens |
| --- | --- | --- | --- | --- |
| Refund | 3018 / 577.6 | 80 | 1894 | 102 / 13 |
| Outage | 1025 / 607.8 | 82 | 1014 | 104 / 13 |
| Quote | 976 / 562.2 | 84 | 2000 | 106 / 13 |

Average end-to-end latency was approximately 1673 ms for Decision and 1636 ms for Flash: this run does not demonstrate a latency advantage. Different endpoints and first-connection overhead affect these measurements. Decision emitted fractional severity (0.56, 2, 0.03), while Flash emitted prompted integer severity (0, 2, 0). Their scoring contracts differ. No monetary cost is inferred from token counts.

Reproduce with `QWEN_DECISION_EVAL=1` and the same Bun/Vitest invocation targeting `packages/qwen/tests/decision-evaluation.live.test.ts`. Optional `QWEN_DECISION_EVAL_OUTPUT` writes only synthetic results, timing and usage as JSON.

## Portable experimental adapter

`experimentalDecisionModel()` adds the common SDK DecisionModel contract without
changing the native extension above. See [portable Decisions](./DECISIONS.md) for
predicate/noul mapping, explicit capabilities and gateway destination selection.
