---
"@zhivex-ai/core": minor
"@zhivex-ai/sdk": minor
"@zhivex-ai/agents": minor
---

Add opt-in toolExecution.validationErrorMode="tool-result" to return sanitized schema validation errors to the model without executing or approving invalid calls. Preserve strict validation by default, correlate results across mixed batches and approval resumes, and account for current tool errors in agent budget preflight.
