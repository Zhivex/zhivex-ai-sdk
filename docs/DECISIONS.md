# Experimental portable Decisions

`DecisionModel` is an experimental contract exported as types from core and SDK.
OpenAI and Qwen expose `experimentalDecisionModel()`. This does not change
`LanguageModel`, chat selection, `scoreTarget`, or the native Qwen
`decisionModel().decide({ state, questions })` extension.

```ts
import { createOpenAI } from '@zhivex-ai/openai';
import { createQwen } from '@zhivex-ai/qwen';
import { createGateway } from '@zhivex-ai/gateway';

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
const qwen = createQwen({
  apiKey: process.env.QWEN_API_KEY,
  decisionBaseURL: 'https://trial.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1'
});
const gateway = createGateway({
  adapters: {},
  decisions: {
    primary: { model: openai.experimentalDecisionModel('gpt-6-luna') },
    backup: { model: qwen.experimentalDecisionModel('decision-model-preview') }
  }
});
const result = await gateway.decide({
  primary: 'primary',
  alternatives: ['backup'],
  maxAttempts: 2,
  fallbackOn: [429, 503],
  timeoutMs: 15_000,
  input: 'Customer reports duplicate billing.',
  questions: {
    urgent: { type: 'predicate', instructions: 'Does this need immediate attention?' },
    team: {
      type: 'choice', instructions: 'Choose the responsible team.',
      choices: [
        { value: 'billing', description: 'Payments and refunds' },
        { value: 'support', description: 'Product faults' }
      ]
    },
    severity: { type: 'score', instructions: 'Rate severity.', levels: ['Minor', 'Blocking'] }
  }
});
for (const answer of Object.values(result.answers)) {
  if (answer.type === 'refusal') continue; // Application-owned refusal handling.
  if (answer.type === 'predicate') console.log(answer.probability);
}
console.log(result.provenance, result.routing);
```

## Contract and compatibility

| Capability | OpenAI | Qwen portable |
| --- | --- | --- |
| Native endpoint | `/v1/decisions` | configured base + `/systemone` |
| Model | `gpt-6-luna` | `decision-model-preview` |
| Predicate | `probability` | `noul` mapped to probability |
| Choice values | strings and booleans, kept distinct | nonempty strings |
| Score | fractional, zero-based level indices | fractional, zero-based criteria indices |
| Evidence | string or ordered text/inline image parts | string |
| Per-question refusal | preserved as `{ type: 'refusal' }` | not supported by native contract |
| Request ID / server latency | absent unless actually supplied by adapter | native values |

`capabilities` advertises question types, input types, text parts, choice value
types and refusal support. Questions are keyed by nonempty IDs. Choices carry
unique typed values and descriptions; score levels are unique nonempty strings.
This intentionally small portable subset does not expose every native API option.
Qwen object state remains available through its unchanged native extension.

`providerConfidence` preserves each provider's native value on choice and score;
it is not a shared calibration or a cross-provider ranking metric. Predicates
remain probabilities, never automatically thresholded booleans. Scores are never
rounded. Results contain exact provider/model/endpoint/protocol provenance and
validated token usage; missing provider fields are not synthesized. Refusals have
no numeric answer and can coexist with successful answers.

## Routing, cancellation and spend

Only registered and explicitly named destinations are eligible. All selected
models validate the request before any network call, including alternatives that
may never run. `allowedProviders`, exact `allowedEndpoints`, and
`requirePerQuestionRefusal` can narrow that selection. No model, provider, endpoint
or data-residency policy is inferred from chat configuration. Registration itself
does not send data. Adding an alternative explicitly authorizes that destination
if its selected fallback condition occurs. Review its own data terms beforehand.

Defaults are one attempt, no retries and no fallback statuses. Increase
`maxAttempts` and supply `fallbackOn` to use ordered alternatives. Supported status
conditions are 429, 500, 502, 503 and 504. No same-target retries are provided by the
portable API. Refusals, malformed responses, transport errors, cancellation and
other HTTP statuses never trigger fallback. Native Qwen explicit retry options
remain unchanged and are not used by the portable adapter.

One deadline covers all attempts, with a default of 30 seconds. Abort and timeout
stop further attempts and bound settlement even if a custom fetch ignores its
signal; such a fetch remains responsible for stopping underlying I/O. Transport
errors and HTTP bodies are sanitized. Requests and responses are bounded to 1 MiB;
IDs, answer types, distributions, score ranges, labels and token quantities are
validated. Hosted image URLs are rejected; OpenAI accepts at most 128 inline base64 images per request; this is checked before network.

For request-local spend admission, configure a conservative `reserveUSD` on each
destination and set `maxReservedUSD` on the request. Unknown reservations fail
closed when a ceiling is supplied. Reservation totals are compared as exact decimal values of the supplied numbers (for example, 0.1 + 0.2 fits a 0.3 ceiling), without an overspend tolerance. If the numeric reporting field cannot represent the exact sum, it rounds upward; admission still uses the exact decimal total. Failed attempts consume reservations too;
an alternative is blocked if it would exceed the remaining allowance.
`routing.reservedUSD` is a reservation sum, **not actual cost**. No provider token
preflight or billable cap exists in this contract. The application must set
reservations appropriate to input size, account, regional premiums and context
pricing; provider-side billing limits remain separate. There is no automatic
monetary estimate when pricing is unknown, including Qwen.

These decision controls are separate from the gateway's chat budget store,
admission, cache, adaptive routing, affinity and observers; `decide` does not use
those chat execution controls. Configure decision restrictions and reservations
explicitly. No shared cross-request decision budget store is included in this
minimum experimental surface.

## Provider evidence and pricing

OpenAI's [guide](https://developers.openai.com/api/docs/guides/decisions) and
[create reference](https://developers.openai.com/api/reference/resources/decisions/methods/create),
checked October 6, 2026, describe public beta, only `gpt-6-luna`, typed choices,
inline images, per-question refusals and usage. Decisions input costs USD 0.10 per
million tokens; no output, cache-read or cache-write charges apply. Regional
processing premiums and long-context input multipliers still apply. The linked
[pricing table](https://developers.openai.com/api/docs/pricing) currently specifies
a 10% regional processing uplift and a 2x long-context input multiplier. These rates
are specific to Decisions and must not be copied from/to chat catalog prices.
This implementation deliberately does not encode a universal all-in rate.

Qwen's [native Decision API](https://docs.qwencloud.com/api-reference/decision-model-api)
and the existing [Qwen validation evidence](./QWEN_CLOUD_DECISION.md) describe
`state`, named `choice`/`noul`/`score` questions, distributions and native metadata.
Endpoint availability is account-specific; no alternate Qwen hostname is selected
automatically. The portable adapter is tested against those native fixtures.

Validation for this addition is offline only. No paid inference, release or npm
publication is part of this change. Both portable adapters and `gateway.decide`
are experimental; the existing native Qwen API and language routing retain their
previous contracts. Automatic chat/Code model selection is out of scope.

Release preparation uses the feature changeset and the repository's `updateInternalDependencies: "patch"` policy to raise OpenAI, Qwen and Gateway's Core dependency floors to the new Core version that exports the Decisions helpers. An offline temporary-workspace regression test checks the resulting manifests; feature branches do not pre-bump published versions.
