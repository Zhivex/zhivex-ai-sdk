# AGENTS.md

## Propósito del repositorio

`zhivex-ai-sdk` es un monorepo TypeScript para Bun/Node con una API unificada para proveedores de IA. La meta es mantener contratos estables en `core` y adapters delgados por proveedor.

## Estructura

- `packages/core`: contratos compartidos, helpers de runtime, mensajes, streaming, embeddings, errores y utilidades de generación.
- `packages/openai`: adapter OpenAI.
- `packages/anthropic`: adapter Anthropic.
- `packages/gemini`: adapter Gemini.
- `packages/sdk`: paquete agregador que reexporta la API pública.
- `README.md`: fuente principal de ejemplos y expectativas de uso.

## Stack y comandos

- Runtime preferido: `bun` 1.3+.
- TypeScript con project references.
- Tests con `vitest`.

Comandos base:

```bash
bun run build
bun run test
bun run typecheck
```

## Convenciones de trabajo

- Mantener `packages/core` como única fuente de verdad para tipos compartidos, capacidades de modelos, errores y helpers de alto nivel.
- Los adapters por proveedor deben traducir entre el contrato de `core` y la API externa; evitar lógica de negocio duplicada entre proveedores.
- Antes de agregar una nueva capacidad, extender primero el contrato compartido en `packages/core/src/types.ts` o módulos afines, y luego adaptar cada proveedor según corresponda.
- Si una feature no aplica a un proveedor, expresarlo mediante `capabilities` o errores explícitos; no introducir comportamientos implícitos.
- Conservar la API pública pequeña y consistente. Si se exporta algo nuevo, revisar también `packages/core/src/index.ts` y `packages/sdk/src/index.ts`.
- Preferir cambios incrementales y compatibles con los ejemplos de `README.md`.

## Testing esperado

- Cualquier cambio en `core` debe venir con tests en `packages/core/tests`.
- Cambios en un proveedor deben validar mapping de mensajes, tools, structured output, streaming y manejo de errores cuando aplique.
- Si se modifica la superficie pública o el comportamiento documentado, actualizar ejemplos o texto en `README.md`.

## Guía de implementación

- Reusar utilidades existentes de `core` como `withRetry`, `withTimeoutSignal`, `streamSSE`, normalizadores de finish reason y errores tipados antes de crear helpers nuevos.
- Mantener nombres y shape de eventos alineados con el contrato de `StreamEvent`.
- En structured output, respetar la distinción entre modo `native`, `prompted` y `auto`.
- Para tools, preservar el loop multi-step y la representación por `parts`.
- Evitar dependencias nuevas salvo que sean claramente necesarias y afecten a más de un paquete o simplifiquen de forma material el mantenimiento.

## Checklist antes de cerrar una tarea

1. `bun run typecheck`
2. `bun run test`
3. `bun run build` si hubo cambios de exports, tipos públicos o referencias entre paquetes
4. Revisar si `README.md` quedó desalineado con la API final

## Qué evitar

- Romper el contrato compartido de mensajes/parts para resolver un caso puntual de un solo proveedor.
- Exportar APIs experimentales sin necesidad clara.
- Acoplar `core` a detalles específicos de OpenAI, Anthropic o Gemini.
- Corregir tests cambiando expectativas válidas sin entender primero la regresión real.
