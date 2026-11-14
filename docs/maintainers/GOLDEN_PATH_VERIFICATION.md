# Golden Path Verification

Use this runbook to validate the product timing claims with a person who has not worked on the SDK. Automated package smoke is necessary, but it is not a substitute for this trial.

## Trial Setup

- Use a new temporary directory outside the repository.
- Copy only `examples/next-runner`; do not copy `node_modules`, `.next`, `.zhivex`, `dist`, or a lockfile from the repository.
- Give the participant the repository-supported Bun version (currently 1.4.2+), a supported Node runtime, and a bounded provider credential through a server-side secret channel.
- Start the clock before they read the starter README.
- Do not coach API choices. Record only blockers and timestamps.

## Checkpoints

1. `bun install` completes from the standalone manifest.
2. The participant sets `OPENAI_API_KEY` in `.env` without placing it in browser code.
3. `bun run first-response` succeeds in under 5 minutes from trial start.
4. `bun run typecheck` passes.
5. `bun run dev` starts the app.
6. Two browser messages keep the same session ID and the second turn uses prior context.
7. Persistent chat succeeds in under 15 minutes from trial start.

## Redacted Evidence Record

Store a record with this shape. Do not include keys, prompts, response text, user identity, or session contents.

```json
{
  "schemaVersion": 1,
  "type": "golden_path_user_trial",
  "status": "passed",
  "testedAt": "2026-08-23T00:00:00Z",
  "sdkVersion": "1.8.0",
  "provider": "openai",
  "modelId": "gpt-4o-mini",
  "bunVersion": "1.3.7",
  "nodeVersion": "24.x",
  "firstResponseMs": 0,
  "persistentChatMs": 0,
  "participantPriorSdkExperience": false,
  "blockers": []
}
```

Mark the HU `Listo` only after the installed-package smoke, applicable repository gates, and at least one passing first-time-user record are linked. A skipped live run or a deterministic smoke is not live-provider certification.

## Trial records

Record participant trials and follow-up in the [internal historical archive in Notion](https://www.notion.so/418777b104f681a089c1c27e90679725). Keep this runbook and evidence format versioned here. The archive migration did not include individual trial results; do not interpret it as a passing trial.
