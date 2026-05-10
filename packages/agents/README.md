# @zhivex-ai/agents

Agent-first facade for the Zhivex AI SDK runtime.

Use this package when an application only needs the portable agent runtime, stores, memory, safety, tracing, evaluation, and provider support helpers. The implementation re-exports the current contracts from `@zhivex-ai/core`; `core` remains the source of truth.

Use `@zhivex-ai/sdk` when you want the broader unified SDK surface, and use provider packages such as `@zhivex-ai/openai` or `@zhivex-ai/gemini` to create concrete models.
