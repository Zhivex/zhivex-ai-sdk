# Dependabot review for the pending SDK release

Reviewed on 2026-09-07 against PR #84 at `6da21d27ba983096bffd8510488c0551827b2292`.
All four updates are suitable for inclusion after the accompanying lockfile,
workflow-test and changeset corrections. This is local validation, not a merge,
published release, or CI result for the combined dependency update.

| PR | Reviewed update | Original CI failure | Preparation |
| --- | --- | --- | --- |
| [#78](https://github.com/Zhivex/zhivex-ai-sdk/pull/78) | `@types/node` 25.9.5 → 26.4.1 | Frozen lockfile mismatch | Updated Bun lockfile; retained exact 26.4.1 resolution under the requested caret range |
| [#79](https://github.com/Zhivex/zhivex-ai-sdk/pull/79) | setup-node 7.0.0, upload-artifact 7.0.1, download-artifact 8.0.1, CodeQL 4.37.9 | Workflow regression tests still expected the old action SHAs | Updated pinned-SHA assertions after reviewing upstream action inputs and runtime |
| [#82](https://github.com/Zhivex/zhivex-ai-sdk/pull/82) | `@anthropic-ai/sdk` 0.119.0 → 0.123.0 | Frozen lockfile mismatch | Updated Bun lockfile and added an Anthropic patch changeset |
| [#83](https://github.com/Zhivex/zhivex-ai-sdk/pull/83) | `@ai-sdk/react` 4.0.82 → 4.0.95 and `ai` 7.0.79 → 7.0.92 | Frozen lockfile mismatch | Updated the development dependencies and their lockfile graph |

Reviewed PR heads: #78 `dd65051b4018c0291e06039050477769ddac698c`,
#79 `f3e87c8e82db9c838e189aaee6d5d78d75771c14`,
#82 `034769fba1d8a37407212588af990c4ef70d92d5`,
#83 `c9f6aeca0ce912b21d996f8583f158578b9cefd4`.

## Compatibility findings

The Anthropic adapter uses the dependency's credential resolver and token-cache
imports. Its Messages, Files and Skills HTTP mapping remains implemented by the
adapter; upstream beta Files/Skills shape changes do not replace that mapping.
Credential refresh/error tests and the complete combined suite pass with 0.123.0.
This review does not add credentialed live certification of a newly published
Anthropic package.

The Vercel packages are development dependencies used for interoperability tests;
this does not add them as runtime dependencies of the published SDK packages.
The Node typings update compiles without adding new Node runtime APIs. Installed
consumer smokes passed on Node 18.18.0 and 22.21.0. The Node 18 install emitted
existing AWS dependency engine warnings requiring Node >=20; those dependencies
were not changed by these PRs. Passing the smoke is not vendor support for AWS
on Node 18.

GitHub-hosted `ubuntu-latest` runners execute the updated actions. The artifact
actions use Node 24 internally; that does not change the Node version selected
for package-consumer tests. The default archive/extraction behavior still matches
the existing upload/download paths. Download v8 fails on digest mismatch by
default; the release's additional SHA-512 verification remains in place.
setup-node v7 removes a dummy auth-token export; the release already uses npm
Trusted Publishing/OIDC and does not rely on that dummy token.

Primary sources reviewed:

- [setup-node v7 release](https://github.com/actions/setup-node/releases/tag/v7.0.0)
- [upload-artifact pinned definition](https://github.com/actions/upload-artifact/blob/043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/action.yml)
- [download-artifact pinned definition](https://github.com/actions/download-artifact/blob/3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/action.yml)
- [Anthropic 0.123.0 release](https://github.com/anthropics/anthropic-sdk-typescript/releases/tag/sdk-v0.123.0)

## Validation and remaining integration

- Bun 1.3.7 regenerated the lockfile and passed a frozen install with scripts disabled.
- Audit: no vulnerabilities found in 336 packages.
- Typecheck, documentation, clean build and internal Core range checks passed.
- Complete combined suite: 98 files, 1,603 tests passed.
- SQLite workflow certification and workflow evaluation gate passed.
- Installed package consumers: 42 entrypoints, CLI, provider transports, Qwen IDs,
  optional OTEL and real OTEL passed on Node 18.18.0/OTEL 1.30.1 and
  Node 22.21.0/OTEL 2.10.0; deterministic Bun golden path also passed.
- The baseline PR #84 had successful CI/CodeQL/Postgres and Node 18/24 checks at
  the time of review. These are baseline checks, not checks of this new commit.

Upload the prepared dependency commit to PR #84, run its complete CI matrix and
obtain the required review before merging. Close the four original Dependabot
PRs as superseded only after their changes are integrated. Release versioning,
internal dependency range review and protected publication remain separate steps.
