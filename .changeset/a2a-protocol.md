---
"@zhivex-ai/core": minor
"@zhivex-ai/sdk": minor
---

Add experimental Agent2Agent (A2A) 1.0 support at `@zhivex-ai/core/a2a` and `@zhivex-ai/sdk/a2a`. `createA2aAgentServer` exposes a Zhivex agent over JSON-RPC, including streaming, task lookup, cancel, and approval resume stored in the Runner session service. `RemoteA2aAgent` and `createRemoteA2aAgentTool` call a remote agent from a parent agent's tools. Browser bundles keep the client and throw from the server factory. `A2A_API_STABILITY_MANIFEST` classifies every runtime export as experimental.
