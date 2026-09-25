---
"@zhivex-ai/core": patch
"@zhivex-ai/sdk": patch
"@zhivex-ai/agents": patch
---

Allow shared budget reservations to represent independent remaining input, output, and total ceilings when resuming approval-paused subagents. Preserve all dimension limits, strict confirmed-usage validation, and unknown-usage reservations when provider totals exceed the input/output sum.
