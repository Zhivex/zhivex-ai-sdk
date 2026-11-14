# Architecture live evidence — 2026-09-30

The full narrative report is in the [internal historical archive in Notion](https://www.notion.so/418777b104f681a089c1c27e90679725). The original JSON evidence and reproduction notes remain below.

This tested a modified local checkout, not published packages. The initial conformance gate recorded 31 passed and 8 failed; subsequent targeted checks do not overwrite that failed gate. Direct Gemini authentication failed; Vertex success does not certify direct Gemini. No package-wide certification is implied.

## Evidencia conservada

- [Corrida inicial: 31 aprobadas, 8 fallidas](architecture-live-2026-09-30-conformance.json)
- [Revalidación DeepSeek: 5 aprobadas](architecture-live-2026-09-30-deepseek-recheck.json)
- [Nuevos modelos: 12 aprobadas y retry Vertex aprobado](architecture-live-2026-09-30-new-models.json)
- [Transportes GPT-6: 4 aprobadas](architecture-live-2026-09-30-targeted.json)
- [Diagnóstico DeepSeek y fallback Gateway](architecture-live-2026-09-30-followup.json)

Comando base: `bun --env-file=.env run scripts/provider-smoke-report.ts --run-live --gate=required`. La revalidación DeepSeek usó `ZHIVEX_INTEGRATION_PROVIDER=deepseek`. Los modelos nuevos usaron `ZHIVEX_SEPTEMBER_MODELS_LIVE=1` y `packages/sdk/tests/september-models.integration.test.ts`. Los transportes usaron los casos OpenAI del harness `scripts/architecture-live-smoke.ts`, adaptados a imports de dist locales y etiquetados como checkout.

Sin configuración suficiente: xAI, Azure OpenAI, OpenRouter, Z.ai, Kimi, Bedrock y Ollama. No se presentan como certificados. Tampoco se certifican aquí vision, audio, video, realtime, herramientas alojadas ni todas las variantes del catálogo.
