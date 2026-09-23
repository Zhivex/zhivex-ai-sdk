---
"@zhivex-ai/core": minor
"@zhivex-ai/sdk": minor
"@zhivex-ai/agents": minor
---

Add configurable streaming replay retention and queue limits, including opt-in bounded tail replay for long text, object, and agent streams. Preserve full replay and text-only error behavior by default and document collect-based completion checks. Separate raw agent context input from parsed schema output in class and functional APIs. Expose operational error constructors through the agents facade and reject invalid maxSteps before generation.
