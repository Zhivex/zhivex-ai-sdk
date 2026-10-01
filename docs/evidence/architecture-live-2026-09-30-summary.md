# Validación live de arquitectura y perfiles de modelos

Fecha local: 30 de septiembre de 2026. Las marcas UTC de los informes corresponden al 1 de octubre.

La validación usa el checkout modificado y su JavaScript compilado. No acredita un paquete publicado ni una instalación externa. Los JSON incluyen el SHA padre, el estado dirty y hashes SHA-256 agregados de fuentes y JavaScript compilado, incluidos los archivos nuevos. Se enviaron únicamente prompts sintéticos. No se registran credenciales ni respuestas completas.

## Resultado por API disponible

| API | Modelo | Resultado final | Alcance |
| --- | --- | --- | --- |
| OpenAI | gpt-5.6-luna | 6/6 aprobadas | Texto, streaming, herramientas, schema, reasoning, embeddings con text-embedding-3-small |
| Anthropic | claude-opus-5 | 5/5 aprobadas | Texto, streaming, herramientas, schema, reasoning |
| Meta Model API | muse-spark-1.2-contributor | 5/5 aprobadas | Texto, streaming, herramientas, schema, reasoning |
| Qwen | qwen3.7-plus | 6/6 aprobadas | Texto, streaming, herramientas, schema, reasoning, embeddings con text-embedding-v4 |
| DeepSeek | deepseek-v4-flash | 5/5 aprobadas al repetir | Texto, streaming, herramientas, schema, reasoning |
| Vertex AI | gemini-3.7-flash | 6/6 aprobadas tras un reintento de generación | Texto, streaming, herramientas, schema, reasoning, embeddings con text-embedding-005 |
| Gemini API directa | gemini-3.7-flash y gemini-embedding-2 | 0/6; HTTP 401 | Autenticación rechazada en todas las comprobaciones |

Gemini directo queda bloqueado por autenticación: disponer de una variable no prueba que la credencial funcione. El éxito de Gemini en Vertex acredita la ruta Vertex, no la API Gemini directa. El gate de conformance inicial continúa fallando; sus resultados no se sobrescribieron.

## Comprobaciones adicionales

- GPT-6 Sol, GPT-6 Luna y Claude Opus 5.5: 12/12 aprobadas, incluyendo generación, streaming, schema nativo y herramientas con continuación de historial.
- GPT-6 Luna: 4/4 comprobaciones de transporte aprobadas (stream de herramientas por Chat Completions y Responses, generación, transporte Chat compartido en Core).
- Gateway: fallback real a GPT-6 Luna aprobado; el candidato retirado fue excluido antes de construir su modelo.
- DeepSeek: stream con 32 tokens, 512 tokens y 32 tokens con thinking desactivado aprobado en el diagnóstico. La primera prueba devolvió texto vacío; no se reprodujo en estas tres llamadas. Es compatible con variabilidad del presupuesto de thinking, sin demostrar un defecto del parser. Se amplió a 256 tokens la prueba de texto del registro; las cinco capacidades pasaron en la nueva corrida.

## Cambios y validación local

El registro de integración consume los perfiles compartidos de OpenAI y Gemini para los controles modernos y la política de sampling. DeepSeek recibe un presupuesto de texto suficiente para reducir truncamientos por thinking.

Tras estos cambios: typecheck, docs:check, provider:check y diff check aprobados; 40 pruebas offline enfocadas aprobadas. La validación completa previa de implementación fue 3159 pruebas aprobadas y 4 omitidas, más build y smokes de dist.

## Evidencia conservada

- [Corrida inicial: 31 aprobadas, 8 fallidas](architecture-live-2026-09-30-conformance.json)
- [Revalidación DeepSeek: 5 aprobadas](architecture-live-2026-09-30-deepseek-recheck.json)
- [Nuevos modelos: 12 aprobadas y retry Vertex aprobado](architecture-live-2026-09-30-new-models.json)
- [Transportes GPT-6: 4 aprobadas](architecture-live-2026-09-30-targeted.json)
- [Diagnóstico DeepSeek y fallback Gateway](architecture-live-2026-09-30-followup.json)

Comando base: `bun --env-file=.env run scripts/provider-smoke-report.ts --run-live --gate=required`. La revalidación DeepSeek usó `ZHIVEX_INTEGRATION_PROVIDER=deepseek`. Los modelos nuevos usaron `ZHIVEX_SEPTEMBER_MODELS_LIVE=1` y `packages/sdk/tests/september-models.integration.test.ts`. Los transportes usaron los casos OpenAI del harness `scripts/architecture-live-smoke.ts`, adaptados a imports de dist locales y etiquetados como checkout.

Sin configuración suficiente: xAI, Azure OpenAI, OpenRouter, Z.ai, Kimi, Bedrock y Ollama. No se presentan como certificados. Tampoco se certifican aquí vision, audio, video, realtime, herramientas alojadas ni todas las variantes del catálogo.
