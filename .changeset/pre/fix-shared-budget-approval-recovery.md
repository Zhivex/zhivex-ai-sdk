---
"@zhivex-ai/core": patch
"@zhivex-ai/sdk": patch
"@zhivex-ai/agents": patch
---

Reserve only a child's remaining token allowance when resuming approvals, preserving its shared budget identity and lifetime limits. Forward only pending approval decisions across repeated resumes. Release an auxiliary allocation as confirmed zero consumption when its initial checkpoint fails before dispatch, while retaining the operation ID to block unsafe retries.
