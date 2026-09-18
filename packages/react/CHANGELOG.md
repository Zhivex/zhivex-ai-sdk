# @zhivex-ai/react

## 0.6.0

### Minor Changes

- Add model-aware React media inputs and video rendering, bounded agent execution summaries and hierarchy, and an optional browser realtime voice hook with PCM audio and a server-owned WebSocket relay. Expose optional realtime interruption and implement Qwen response cancellation. Keep provider credentials and tool execution on the server.
  
  Fix resumed tool approvals so the original tool card completes and the final response remains an assistant message. Include a runnable Qwen Omni/voice example and browser regression coverage for uploads, approvals, replay, microphone capture and interruption.
  
  Refresh chat spacing, composer focus, responsive prompt cards and agent status badges while preserving theme tokens. Modernize the example's voice controls with explicit microphone state, surfaced action errors and a keyboard alternative. Request PCM output in the voice example and avoid idle provider cancellation when only local playback needs clearing.

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.19.0

## 0.5.0

### Minor Changes

- Add opt-in cursor replay with authenticated server-side in-memory buffering, bounded native reconnect attempts and explicit background cancellation. Coalesce streaming deltas and avoid duplicate reducer work. Add optional Markdown and variable-height virtualized message entrypoints, plus cancellable attachment preparation, upload adapters, previews, progress, retries and consistent accept validation. Prevent a Stop click from becoming an unintended submit when the button changes state. Add an application-owned AI SDK UI reconnect handler, a runnable Next.js replay example, a reducer benchmark, and Chromium end-to-end coverage.
- Add sendMessageWithResult and ChatSendResult while preserving the legacy send return contracts. Restore unedited drafts after failed or stopped sends, retain attachments until successful completion, preserve files added during a request, and prevent duplicate Composer submissions. Preserve buffered partial output on transport failure.

## 0.4.0

### Minor Changes

- 26947d9: Add the Beta `@zhivex-ai/react/compat` entrypoint for AI SDK UI v7 interoperability. It includes bidirectional `UIMessage` adapters, bounded request parsing, AI SDK UI v1 stream responses, a secure `useChat` transport with abort and approval propagation, versioned protocol fixtures, and an explicit part compatibility matrix.

### Patch Changes

- Updated dependencies [ed84fd9]
  - @zhivex-ai/core@1.11.0

## 0.3.0

### Minor Changes

- Upgrade the ready-made chat with multimodal attachments, starter prompts, run progress, grouped tool execution, message actions and statuses, approval reasons, safe error presentation, explicit themes, compact density, improved accessibility, and a more polished responsive visual system.

## 0.2.2

### Patch Changes

- Harden durable subagent recovery, file-store revision CAS, supervised approvals, ledger redaction, artifact integrity, authenticated redirects, provider diagnostics, remote-media policies, Formula tool names, local CLI exports, and release artifact trust boundaries.
- Updated dependencies [888bf99]
- Updated dependencies
  - @zhivex-ai/core@1.1.2

## 0.2.1

### Patch Changes

- Serialize binary audio safely in the default fetch transport and restore stopped user-message status when reloading a request.

## 0.2.0

### Minor Changes

- ec9a323: Add server-safe package subpaths, multimodal chat input, controlled sessions,
  batched streaming updates, bounded activity, explicit stopped messages,
  public-safe transport errors, respectful auto-follow, accessible completion
  announcements, and browser interaction coverage.

### Patch Changes

- Updated dependencies [4188b59]
- Updated dependencies [4188b59]
  - @zhivex-ai/core@1.1.0

## 0.1.1

### Patch Changes

- 748944f: Harden credentialed endpoints, uploads, response and stream bounds, cancellation, provider resource identifiers, agent persistence and approvals, gateway routing, React chat rendering, local CLI output, and release provenance verification.
- Updated dependencies [748944f]
  - @zhivex-ai/core@1.0.2

## 0.1.0

### Minor Changes

- 63f9930: Add the first Zhivex React chat package with headless state, fetch/SSE transport, accessible customizable components, and Runner-aware UI streaming.

### Patch Changes

- Updated dependencies [63f9930]
- Updated dependencies [1150a70]
  - @zhivex-ai/core@1.0.0
