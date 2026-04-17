# @zhivex-ai/gateway

Routing and fallback package for Zhivex AI SDK.

The gateway now supports:

- `generate()`
- `streamText()`
- `generateObject()`
- `streamObject()`
- `runAgent()`
- `streamAgent()`

Tool loops continue to run on the selected target after routing, and streaming fallbacks are resolved before the first chunk is emitted.

For agent routing, the gateway can also filter by `agentCapabilities`, such as provider support tier or approval-capable MCP support, before selecting the final target.

## Install

```bash
bun add @zhivex-ai/gateway
```

Repository and full documentation:

- <https://github.com/Zhivex/zhivex-ai-sdk>
