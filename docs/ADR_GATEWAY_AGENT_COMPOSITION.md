# Gateway agent composition

Decision for SDK-AGW-HU-12: extend the existing gateway facade with an optional configured `AgentDefinition`, and retain the existing routed LanguageModel within Core's run/stream loop.

A second agent loop would duplicate checkpoints, approval handling and tool-effect boundaries. Exposing a standalone routed model would omit request/attempt metadata lifecycle and make durable route binding implicit. The facade preserves the definition, applies explicit invocation overrides, and validates route binding before loading a configured durable run.

Input context remains ephemeral and validated by the definition schema. Store and hooks default from the definition; invocation fields take precedence when defined. Policy and metadata merge shallowly, and compaction may be disabled explicitly. Harness/environment identity is still enforced by Core. Routes may fall back within the bound target set before provider output, but consumers must create a new run or a deliberate migration to change the bound routes of an existing run. Legacy gateway calls remain available.

The binding is an application-level consistency check, not a signature or access-control boundary. Output typing on the existing gateway response remains `unknown`; callers validate/use their configured output schema. No direct-run migration or cross-process router is introduced.
