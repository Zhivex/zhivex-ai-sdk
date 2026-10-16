---
"@zhivex-ai/core": minor
"@zhivex-ai/react": minor
---

Reject duplicate tool-call IDs before approval or execution, and keep each approval decision on its own call. UI streams omit terminal agent run state unless `includeAgentRunFinish` is set, and `agent-step-finish` chunks are status summaries. This is a breaking default for `toUIMessageStream`, `toUIMessageStreamResponse`, and `toUIAgentStreamResponse`. React chat activity uses the same step summary.

Workflow state must match the authenticated user, and a supplied session or workflow id must match too. Persisted workflow steps take a 15-minute execution claim that the owner renews every 5 minutes. A lost renewal fails that owner without writing its terminal state. The claim, each renewal, and the terminal state advance the workflow record revision. Runner approval resumes compare-and-swap the loaded session revision, so a losing resume cannot execute the approved tool. Memory, SQLite, file, and PostgreSQL idempotency claims no longer overwrite an existing run id, and a failed key write does not leave the new run behind.

`toUIMessageStreamResponse`, `toUIAgentStreamResponse`, and `toUIRunnerStreamResponse` accept `includeAgentRunFinish` and forward it. The default remains off.
