---
"@zhivex-ai/gateway": minor
---

Add bounded opt-in local destination metrics with in-flight counts, rolling latency and TTFT, error/cancellation separation, and an injectable clock/store. Metrics-enabled stream iterator cancellation aborts the routed operation and releases its slot without waiting for an uncooperative provider.
