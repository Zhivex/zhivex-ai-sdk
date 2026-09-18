# React, Agents and Qwen live certification

Date: 2026-09-18 UTC. Result: **GO for the tested development integration**.
This is local source validation, not npm publication, deployment or a multi-region GA gate.
HTTP endpoint: `dashscope-intl.aliyuncs.com` (Singapore default); realtime endpoint derived
from that provider configuration. Credentials remained in the server environment.

## Provider evidence

| Surface | Model | Result |
| --- | --- | --- |
| Chat and Responses text, streaming reasoning/usage, image+audio understanding, video, callable tools; prompted JSON and hosted web search | `qwen3.8-omni-flash` | 12/12 passed in the final full run, 110.74 s |
| React server relay: real PCM output/transcripts, cancel active response, reuse session, PCM input | `qwen3.5-omni-flash-realtime` | Passed, 10.99 s including synthetic speech |
| Chromium → local application → real agent: approval, resume, returned tool context and completed run UI | `qwen3.8-omni-flash` | Passed |
| Chromium → WebSocket relay → real voice provider: nonempty audio frames, transcript, disconnect | `qwen3.5-omni-flash-realtime` | Passed |

The speech fixture was synthesized locally with macOS Samantha, converted to raw signed
16-bit little-endian PCM, mono 16 kHz. It asked “Please say exactly: audio input verified.”
The provider recognized the phrase and returned PCM speech. No personal microphone was
recorded. The relay run received 8 audio frames before active cancellation and 7 during the
next completed text-triggered response; a subsequent PCM speech turn also completed.

The HTTP first full run passed 11/12. Hosted search completed with Qwen sources, but the
final answer selected `qwenlm.github.io`/`tongyi.aliyun.com` rather than the test's exact
`qwen.ai`/`qwen.cloud` expectation. An unchanged focused rerun reproduced that assertion
failure. The assertion now validates a parsed URL against a bounded list of official Qwen
hosts, while retaining the original completed-search and source checks. The final full
12-scenario run passed. This verifies integration, not universal answer correctness.

During certification, the development voice example was corrected to explicitly request
`outputAudioMediaType: "audio/pcm"`; previously its config selected text-only output.
The React hook also clears local playback without issuing idle cancellation, which Qwen
rejects when no inference is active. Active cancellation remains covered by the live relay.

## UX and regression evidence

- Refreshed reusable chat spacing, prompt cards, composer focus, theme tokens and agent status badges.
- Example voice panel: explicit connection/microphone state, surfaced errors, typed input alternative, bounded transcript list.
- Chromium fixture: 8/8 passed, including 390 px dark mode, reduced motion, keyboard focus,
  uploads, replay, approvals, fake microphone start/stop/restart and disconnect.
- Final local gates: 1,921 tests / 141 files passed; typecheck, build, documentation
  checks (101 Markdown files, 19 packages and 3 typed examples) and clean packed React
  consumer installation passed. The first sandboxed test run failed only on loopback
  `listen EPERM`; the permitted rerun passed.
- Live browser tests assert receipt of real audio frames and no page errors; this does not
  prove sound quality on a physical speaker or microphone.

## Reproduce

From the repository root, with Qwen credentials in the server environment:

```bash
QWEN_OMNI_INTEGRATION=1 bun --env-file=.env run test:integration packages/qwen/tests/omni-flash.integration.test.ts --reporter=verbose
QWEN_REACT_INTEGRATION=1 QWEN_LIVE_PCM_PATH=/path/to/synthetic.pcm bun --env-file=.env run test:integration packages/react/tests/qwen-realtime.integration.test.ts --reporter=verbose
QWEN_REACT_INTEGRATION=1 bunx playwright test --config playwright.react-live.config.ts
bun run test:react:browser
```

Only the explicitly opted-in suites call Qwen. The standard browser suite uses deterministic
fixtures and a simulated microphone. The optional PCM file must be 16 kHz mono PCM16LE,
at most 30 seconds, containing the phrase above; omitting it does not certify speech input.
Local screenshots are under `.cache/react-live-results` and `.cache/react-browser`.

## Limits

No physical audio-device quality, Safari/Firefox, WebRTC, long-session/load, regional,
production authentication/storage or npm release certification was performed. The demo's
in-memory stores and development cookie must be replaced before production deployment.
HTTP Omni and voice use distinct models. Realtime tool approvals remain application-owned;
the live browser approval test covers the HTTP agent runtime.

References: [Qwen client events](https://www.alibabacloud.com/help/en/model-studio/client-events),
[Qwen's official blog redirect](https://qwenlm.github.io/),
[HTTP model validation](./QWEN_OMNI_FLASH_LIVE.md),
[runnable example and production boundaries](../examples/react-omni/README.md).
