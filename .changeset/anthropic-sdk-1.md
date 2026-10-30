---
"@zhivex-ai/anthropic": patch
---

Upgrade the native Anthropic SDK to 1.3.0. Managed Agents use the native routes without the retired beta query parameter, retaining Zhivex credential resolution, redirect rejection, beta headers, and the configured API version. Messages remain on the adapter's direct transport with the 2023-06-01 default API version.
