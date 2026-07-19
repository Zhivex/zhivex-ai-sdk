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
bun run typecheck
bun run test
bun run build
```

Run provider smoke before meaningful stable or prerelease publishes:

```bash
bun run smoke:providers
```

Missing credentials are reported as skipped, not passed. Save the report in release notes or the release checklist when live provider coverage matters.

Check package contents without writing tarballs:

```bash
(cd packages/core && bun pm pack --dry-run)
(cd packages/sdk && bun pm pack --dry-run)
```

Repeat for any provider package included in the changesets.

## Stable Release To `latest`

Use this flow only for stable releases. Apply versioning and commit the resulting package manifests and lockfile before publishing:

```bash
bun run typecheck
bun run test
bun run build
bun run smoke:providers
bun run version-packages
bun run typecheck
bun run test
bun run build
git status --short
```

Push the committed release source to `main`, then dispatch `.github/workflows/release.yml` with channel `latest`. The workflow checks out immutable committed source, installs dependencies without lifecycle scripts, repeats audit/typecheck/test/build, publishes through npm trusted publishing, and only then pushes the package version tags created by Changesets to the same source commit.

`bun run release` is intentionally restricted to GitHub Actions with an available OIDC token. Do not add `NPM_TOKEN` to the workflow. If authentication fails, fix the npm trusted-publisher configuration and rerun the workflow; do not publish individual dependent packages around the failed batch.

Before the first OIDC release, configure every `@zhivex-ai/*` package on npm with this trusted publisher:

- organization: `Zhivex`
- repository: `zhivex-ai-sdk`
- workflow: `release.yml`
- allowed action: `npm publish`
- environment: `npm`

The workflow uses Node 24 and verifies npm is at least 11.5.1. GitHub Actions receives `id-token: write`; npm then generates provenance automatically for public packages.

Before publishing, verify that no package version contains a prerelease suffix such as `-next.0`, `-alpha.0`, `-beta.0`, or `-rc.0`.

After publishing, verify registry metadata:

```bash
npm view @zhivex-ai/core version dist-tags --json
npm view @zhivex-ai/sdk version dist-tags --json
```

For packages included in the release, repeat `npm view <package> version dist-tags --json`.

## Prerelease To `next`

Use this flow for prerelease validation. Never use `bun run release` as the publish step for a prerelease unless the command is explicitly changed to publish with the intended tag.

```bash
bunx changeset pre enter next
bun run version-packages
bun run typecheck
bun run test
bun run build
bun run smoke:providers
```

Commit and push the prerelease manifests, then dispatch `release.yml` with channel `next`. The workflow validates that pending versions use the `next` suffix and publishes with the explicit `next` dist-tag. Keep using that channel for follow-up prereleases while pre mode is active.

When the prerelease cycle is done:

```bash
bunx changeset pre exit
bun run version-packages
bun run typecheck
bun run test
bun run build
```

Review the final stable versions before publishing to `latest`.

After publishing a prerelease, verify:

```bash
npm view @zhivex-ai/core dist-tags --json
npm view @zhivex-ai/sdk dist-tags --json
```

The prerelease version should be under `next`, not `latest`.

## Fresh Install Smoke

After publish, test a clean install in a temporary project. Use `latest` for stable releases:

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
