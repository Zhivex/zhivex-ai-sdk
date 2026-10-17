# Release Guide

Use this guide when preparing a stable or prerelease npm publish. Do not publish from memory. Keep stable `latest` releases and prerelease `next` releases separate.

## Before Any Publish

Start from the repository root.

```bash
git status --short
git branch --show-current
bun run release:check
```

Stable publishing must run from `main`. The release check requires a clean worktree, compares every workspace version and internal dependency range with the live npm registry, and blocks divergent-branch publishes, versions behind npm, unresolved internal dependencies, immutable-version metadata drift, prereleases targeting `latest`, and stale tags that the pending release cannot repair.

The working tree should contain only intended release changes. Review pending changesets:

```bash
find .changeset -maxdepth 1 -type f -name "*.md" -not -name "README.md" -print
```

Each consumer-facing package change should have the correct package names and bump type. Public exports, types, behavior changes, or npm-facing metadata changes need a changeset. Test-only or unpublished-tooling changes usually do not.

Run the standard gates:

```bash
bun run docs:check
bun run typecheck
bun run test
bun run build
bun run smoke:packages
bun run smoke:packages:mcp
```

Run provider smoke before meaningful stable or prerelease publishes:

```bash
bun run smoke:providers
```

Missing credentials are reported as skipped, not passed. Save the report in release notes or the release checklist when live provider coverage matters.

`smoke:packages` packs every workspace package, installs the tarballs together in an isolated temporary Node consumer, imports every JavaScript export, and exercises runtime-sensitive Core behavior. It uses its own temporary npm cache and does not publish anything.

CI also runs `node scripts/package-manager-consumer-smoke.mjs <npm|pnpm|yarn|bun>` with pinned manager versions. Before publication, its temporary loopback registry serves only the exact packed `@zhivex-ai` batch, retaining package manifests, internal ranges and artifact hashes. Other dependencies still come from npm. A missing or incompatible internal candidate fails installation rather than falling back to an older published SDK package. Runtime smoke tests use deterministic providers. After publication, use `--registry=public` to validate transitive resolution against npm instead of the candidate registry.

For a quick manual inspection of individual package contents without writing tarballs:

```bash
(cd packages/core && bun pm pack --dry-run)
(cd packages/sdk && bun pm pack --dry-run)
```

Repeat for any provider package included in the changesets.

## Stable Release To `latest`

Use this flow only for stable releases. Apply versioning and commit the resulting package manifests and lockfile before publishing:

```bash
bun run docs:check
bun run typecheck
bun run test
bun run build
bun run smoke:providers
bun run version-packages
bun run docs:check
bun run typecheck
bun run test
bun run build
bun run smoke:packages
git status --short
```

`bun run version-packages` also synchronizes the standalone Next.js starter pins for SDK, OpenAI, and React, the provider registry, and Bun workspace snapshots with the generated package versions. The snapshot synchronizer updates only workspace versions and internal ranges, preserving external resolutions byte for byte; external dependency or inventory changes require a real Bun lockfile regeneration. Run `bun run lock:check` to detect stale snapshots even when a frozen install accepts them. Review that diff and rerun `docs:check` and the internal Core range tests after versioning; providers that import new Core helpers must require the version that introduced them. For an already versioned, unpublished batch with stale snapshots, run `bun scripts/sync-lock-workspaces.ts` without repeating Changesets.

Push the committed release source to `main`, then dispatch `.github/workflows/release.yml` with channel `latest`. The `validate` job has no OIDC permission: it checks out immutable committed source, installs dependencies without lifecycle scripts, scans for recognized secret signatures, repeats audit/typecheck/test/build and the packed Node consumer smoke, then produces the exact release batch as commit-bound SHA-512 tarballs. The separate `publish` job is the only OIDC trust boundary. It does not check out the repository, install dependencies, or run repository scripts. It downloads the validated tarballs, checks `SHA512SUMS`, revalidates the manifest and batch inside the workflow, and publishes those tarballs with `npm publish --tag` and `--provenance`. Channel `latest` and channel `next` are selected in that same publish step. The workflow does not run `npm dist-tag`. Package tags are pushed only after npm integrity, dist-tags, and the signed SLSA provenance subject and source commit match the release. `gitHead` is also checked when npm provides it. After `publish` succeeds, `verify_public` checks the same versions, dist-tags, and provenance again from the public registry, then installs the published batch with retries. That job has `contents: read` only: no `npm` environment, no OIDC token, and no token that can publish or move dist-tags.

Tag discovery comes from npm metadata rather than only from tags created inside the current runner. This lets a safe rerun recover every tag from a partially successful publish while excluding unchanged packages from older commits.

There is no local publish command. `scripts/release-artifacts.ts publish` refuses to run, including inside the OIDC job. That job publishes the already validated tarballs directly with `npm publish --tag latest` or `npm publish --tag next` plus `--provenance`. Tag collection runs only after `verify_public` succeeds. That job checks out source and has no OIDC token. `push_tags` depends on collection, so package tags and the GitHub release are pushed only after public verification passes. Do not add `NPM_TOKEN` to the workflow. If authentication fails, fix the npm trusted-publisher configuration and rerun the workflow; do not publish individual dependent packages around the failed batch.

Before the first OIDC release, configure every `@zhivex-ai/*` package on npm with this trusted publisher:

- organization: `Zhivex`
- repository: `zhivex-ai-sdk`
- workflow: `release.yml`
- allowed action: `npm publish`
- environment: `npm`

The workflow uses Node 24 and verifies npm is at least 11.5.1. Only the minimal publish job receives `id-token: write`; npm then generates provenance automatically for public packages.

Before publishing, verify that no package version contains a prerelease suffix such as `-next.0`, `-alpha.0`, `-beta.0`, or `-rc.0`.

After publishing, verify registry metadata:

```bash
npm view @zhivex-ai/core version dist-tags --json
npm view @zhivex-ai/sdk version dist-tags --json
```

For packages included in the release, repeat `npm view <package> version dist-tags --json`.
The automated postpublish gate retries registry reads for up to roughly one minute because newly
published versions and dist-tags can become visible at slightly different times.

If the publish log shows the tarballs were accepted but the postpublish gate or `verify_public`
still expires, do not run `version-packages` again and do not try to republish immutable versions.
Check every reported package and dist-tag with `npm view`, then rerun the release workflow after
registry propagation. A rerun selects only versions that are still unpublished. npm can omit
`gitHead` when publishing prebuilt tarballs, so the verifier reads the official registry attestation
and binds its signed SLSA subject digest to npm integrity, the protected `release.yml` workflow, and
the exact source commit. Contradictory `gitHead` and provenance evidence is rejected. A failed
`publish` job skips `verify_public`, and a failed `verify_public` job skips tag collection. Either
failure skips the tag-push job, so recover package tags only after all versions, dist-tags,
integrity, and provenance are confirmed, and point them to that exact release source SHA.

`verify_public` installs the release batch from `https://registry.npmjs.org` in a temporary project
with `npm install --ignore-scripts`. It retries because a version can appear in registry metadata
before its tarball can be fetched. The install drops `NPM_TOKEN` and `NODE_AUTH_TOKEN` from the
child environment and does not publish. An empty batch skips the install.

## Prerelease To `next`

Use this flow for prerelease validation. Publish only through the protected `release.yml` workflow with channel `next`. There is no local publish command.

This repository uses Changesets 3. Its generated `pre.json` contains `mode` and
`tag`; the older `initialVersions` and `changesets` fields are no longer required.
New changesets belong directly in `.changeset/`. After `version`, Changesets moves
consumed changesets to `.changeset/pre/` and retains them for the eventual stable
changelog. Do not move those consumed files back or reconstruct the v2 state.
See the [Changesets prerelease guide](https://changesets.dev/guide/prereleases#manage-prerelease-changesets).
`scripts/prerelease-lifecycle.test.ts` verifies `next.0` → `next.1` → stable using
the installed CLI in a temporary workspace, without publishing anything.

```bash
bunx changeset pre enter next
bun run version-packages
bun run docs:check
bun run typecheck
bun run test
bun run build
bun run smoke:packages
bun run smoke:providers
```

Commit and push the prerelease manifests, then dispatch `release.yml` with channel `next`. The workflow validates that pending versions use the `next` suffix and publishes with the explicit `next` dist-tag. Keep using that channel for follow-up prereleases while pre mode is active.

When the prerelease cycle is done:

```bash
bunx changeset pre exit
bun run version-packages
bun run docs:check
bun run typecheck
bun run test
bun run build
bun run smoke:packages
```

Review the final stable versions and generated package changelogs before publishing to `latest`.

After publishing a prerelease, verify:

```bash
npm view @zhivex-ai/core dist-tags --json
npm view @zhivex-ai/sdk dist-tags --json
```

The prerelease version should be under `next`, not `latest`.

## Keep `next` From Falling Behind `latest`

`npm publish --tag latest` does not move `next`, and `npm publish --tag next` does not move `latest`. Each channel is published only by the `publish` job. Trusted publishing with OIDC can run `npm publish`; it cannot run `npm dist-tag add` or `npm dist-tag rm`. A follow-up dist-tag job fails with npm `E403` after the packages are already published, so the workflow does not try.

`next` means the current prerelease channel. It exists while `changeset pre enter next` is in effect and channel `next` publishes `-next.N` versions. After `bunx changeset pre exit` and a stable publish, `next` stays on the last prerelease. That tag can be older than `latest`, so `bun add @zhivex-ai/sdk@next` can install a downgrade. `bun run release:check` warns when this happens and does not fail the publish: the pending stable batch must still be able to ship, and channel `next` cannot republish a stable version (`stable versions must publish to the latest dist-tag`).

`scripts/align-next-dist-tag.ts` is the same warning as a read-only registry check. `verify_public` runs it after publication, without OIDC. It prints the packages whose `next` tag is older than `latest` and exits successfully. It does not add, remove, or retarget dist-tags. A registry read failure in this check is also a warning. A higher prerelease, such as `1.33.0-next.0` while `latest` is `1.32.0`, is left alone because it is not older than `latest`.

```bash
bun run scripts/align-next-dist-tag.ts
```

Removing a stale `next` tag is a separate maintainer action on npm, outside GitHub Actions, and only after the release freeze. Do not add `NPM_TOKEN` to the workflow to do it. Removal makes `@next` uninstallable until the next prerelease:

```bash
npm dist-tag rm @zhivex-ai/sdk next
```

Repeat for every `@zhivex-ai/*` package that still has a stale `next` tag. Consumer docs install `@zhivex-ai/sdk` from `latest` or pin an exact version. Do not tell application developers to install `@next` unless a prerelease was just published and `npm view @zhivex-ai/sdk dist-tags --json` shows `next` newer than `latest`.

## Fresh Install Smoke

`verify_public` already installs the exact published versions from the public registry and retries while npm propagation catches up. For a manual check in a temporary project, use `latest` for stable releases:

```bash
tmpdir="$(mktemp -d)"
cd "$tmpdir"
bun init -y
bun add @zhivex-ai/sdk@latest @zhivex-ai/core@latest
bun -e 'import { getApiStability } from "@zhivex-ai/sdk"; console.log(getApiStability("createRunner")?.stability)'
```

For prereleases, use `next`:

```bash
tmpdir="$(mktemp -d)"
cd "$tmpdir"
bun init -y
bun add @zhivex-ai/sdk@next @zhivex-ai/core@next
bun -e 'import { getApiStability } from "@zhivex-ai/sdk"; console.log(getApiStability("createRunner")?.stability)'
```

If the release included provider packages, install and import those provider packages in the temp project as well.

## Stop Conditions

Do not publish if any of these are true:

- validation fails
- the current branch is not `main`
- the worktree contains uncommitted or untracked release input
- changesets do not match the packages changed
- `smoke:providers` reports an unexpected configured-provider failure
- a prerelease version would publish to `latest`
- package dry-run includes unexpected files
- package manifests have unexpected `exports`, `types`, `files`, or dependency ranges
- `bun run release:check` reports registry, dist-tag, or internal dependency drift
- npm trusted publishing, the protected `npm` environment, or scope access is unclear

Publishing is irreversible enough to deserve a pause. Fix the issue, rerun the relevant checks, and only then continue.
