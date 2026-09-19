# Vertex readiness and remaining work

Evidence snapshot: 2026-09-19. The full requested objective is not complete.
This document distinguishes implementation, verification and external blockers.
It does not treat every Google Cloud service as an adapter API.
The inference-versus-platform-administration scope question is awaiting a user
answer. Training, tuning, deployment administration, evaluation administration
and MLOps must not be advertised as implemented by this provider.

## Implemented and verified boundaries

| Boundary | Current evidence | What it does not prove |
| --- | --- | --- |
| Source contracts | 2,397 tests passed; typecheck and clean build passed | Every upstream model or optional parameter works live |
| Package consumption | Versioned isolated consumer types, runtime scenarios and CLI passed | Publication or registry availability of these changes |
| Catalog | Generated 65-entry routing/capability matrix matches the checked-in file | Account access; lifecycle entries can be historical |
| gRPC transport | Installed package passed five RPCs on Node 22.21.0 and Bun 1.4.0 against local TLS, with bearer metadata, exact tensor integers and cancellation | Successful inference against a deployed Vertex endpoint |
| Real gRPC service | ADC request reached Google and returned code 5 NOT_FOUND for an absent endpoint | Model-serving availability or input-schema compatibility |
| Live inference | Selected Google and partner chat, embeddings, media, caches, GCS batch, grounding, synchronous Transcribe and Live transcription scenarios passed | Universal certification across model IDs, regions or modalities |

For exact tested models and limitations, see the provider's
[verification table](../../packages/vertex/README.md#verification-and-remaining-limits)
and [catalog matrix](VERTEX_CATALOG_MATRIX.md). Neither a successful factory
construction nor a native API wrapper is a live certification.

## Remaining work by cause

| Cause | Requirement | Concrete next evidence |
| --- | --- | --- |
| External resource | Successful deployed-endpoint inference, including HTTP and gRPC | An endpoint supporting the selected RPC plus its valid input schema; read-only listings found no endpoints in global or us-central1 |
| External resource | Private Vertex AI Search grounding | A test datastore and access to non-sensitive documents |
| Project configuration | BigQuery-backed batch lifecycle | BigQuery enabled and a designated temporary dataset/location |
| Project configuration | Real CMEK cache operations | A compatible KMS key, region and service permissions |
| Account access or quota | Claude, Mistral/Codestral, eligible partner batch and remaining publisher scenarios | Successful bounded calls after access/quota/region issues are resolved; current 404/429 results are not success |
| Account quota and live verification | Dedicated Live translation | Corrected setup accepted; one probe returned audio; subsequent v1beta1 response explicitly reported quota exceeded in a text part. Expected translated text and completion remain unverified |
| Unverified runtime event | Server-originated Live tool cancellation | A real cancellation event with the expected executor abort behavior |
| Quality evaluation | OCR completeness and broader media/retrieval quality | Representative inputs with unchanged expected outcomes; DeepSeek OCR still omits words in the synthetic fixture |
| Scope decision | Training, tuning, deployment/evaluation administration and MLOps | Explicit platform scope and a concrete API design before implementing those service families |
| Delivery | Release readiness | Package versions have been prepared with Changesets; merge and publication require the protected release workflow and its checks |

A quality failure is not proof that an adapter's transport is broken. Conversely,
a successful HTTP/RPC response is not proof that an OCR or retrieval quality
assertion passed. Preserve both findings without weakening the assertion.

No cloud job or temporary bucket from completed batch tests remains scheduled
for cleanup; their removal was checked. New deployed infrastructure has not
been provisioned. Do not start repeated billable probes against unchanged
quota/access failures without a new hypothesis or changed external state.

## Reproduce package and transport evidence

Use Bun for repository commands:

```bash
bun run typecheck
bun run test --maxWorkers=2
bun run build
bun run docs:check
bun scripts/vertex-package-smoke.ts --versioned
```

The package smoke prints its disposable consumer directory. Use that directory
with the transport smoke to test the installed artifact and its dependency graph:

```bash
bun scripts/vertex-grpc-transport-smoke.ts --consumer /absolute/consumer
node --experimental-strip-types scripts/vertex-grpc-transport-smoke.ts --consumer /absolute/consumer
```

The Node flag runs the internal TypeScript test script; the package itself is
compiled JavaScript. The transport smoke creates a local TLS server and removes
its temporary certificates. It does not call Google or create cloud resources.
