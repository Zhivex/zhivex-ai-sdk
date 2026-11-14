# Maintainer Docs

These documents are for repository maintainers and release operators. They are not part of the SDK adoption path for application developers.

- [Release Guide](./RELEASE.md): stable and prerelease npm publishing workflow.
- [Agent Release Readiness](./AGENT_RELEASE.md): agent-focused public surface, docs, examples, and validation gate.
- [Agent Live Certification Evidence](./AGENT_LIVE_CERTIFICATION.md): date-bound durable agent and installed-tarball evidence.
- [Realtime/Live Agent Certification](./AGENT_REALTIME_CERTIFICATION.md): fail-closed Gemini, Qwen, and OpenAI live gate plus deterministic tarball criteria.
- [Provider Conformance and Smoke](./PROVIDER_SMOKE.md): versioned JSON/Markdown evidence, TTL, baselines, installed artifacts, CI attestations, and live provider setup.
- [Model and Provider Maintenance](./MODEL_ONBOARDING.md): profile-based model onboarding, registry generation and coherence checks.
- [Agent store identity migration](./AGENT_STORE_MIGRATION.md): upgrade existing agent run and memory stores to canonical identity keys.

## Historical reports and ownership

Technical procedures, certification summaries, raw JSON evidence, generated matrices and benchmark artifacts remain versioned in this repository. Narrative attempt histories, dated blockers and user-trial follow-up live in the [internal historical archive in Notion](https://www.notion.so/418777b104f681a089c1c27e90679725) (workspace access required). Public documentation remains usable without that archive.

- [Vertex verification and reproduction](./VERTEX_READINESS.md)
- [September provider certification: scope, procedure and evidence](./WEEKLY_PROVIDER_LIVE_2026_09_16.md)
- [Architecture live evidence and reproduction](../evidence/architecture-live-2026-09-30-summary.md)
- [Golden Path procedure and trial format](./GOLDEN_PATH_VERIFICATION.md)

Historical results keep their original dates; migration to Notion is not a new certification.
