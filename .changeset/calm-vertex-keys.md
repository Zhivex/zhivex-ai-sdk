---
"@zhivex-ai/vertex": patch
"@zhivex-ai/bedrock": patch
---

Add Vertex API key auth, lazy access token support, automatic ADC auth, and naming notes for Gemini Enterprise Agent Platform.

Support explicit Amazon Bedrock API keys in native Converse mode by passing `createBedrock({ region, apiKey })` through to the AWS SDK bearer-token configuration, and refresh Bedrock authentication docs for AWS SDK credentials, `AWS_BEARER_TOKEN_BEDROCK`, and Mantle/OpenAI-compatible endpoints.
