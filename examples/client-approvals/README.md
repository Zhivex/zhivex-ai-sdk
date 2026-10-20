# Client approvals and useObject

Offline example for a governance pause, a browser approval, and a streaming object. The server uses a mock model. It does not call a live provider.

```bash
bun run build
bun examples/client-approvals/server.ts
```

Open `http://127.0.0.1:3112`.

- `POST /api/agent` streams AG-UI events and, when the deploy tool pauses, a `zhivex.approval.pause` event.
- `POST /api/approvals` checks the decision against that run and resumes through `resumeApproval`.
- `POST /api/object` streams `streamObject` events for `useObject`.
