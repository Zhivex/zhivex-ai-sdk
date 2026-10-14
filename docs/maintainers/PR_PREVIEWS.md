# Pull request package previews

`.github/workflows/preview.yml` uploads installable tarballs to [pkg.pr.new](https://github.com/stackblitz-labs/pkg.pr.new) for a pull request. It does not publish to npm and it does not run `.github/workflows/release.yml`.

## No npm provenance

Preview packages are not npm releases. They have no npm provenance attestation, they do not move the `latest` or `next` dist-tags, and they must not be treated as a published `@zhivex-ai/*` version. `--previewVersion` rewrites each packed version to `0.0.0-preview-<sha>` before upload so a lockfile cannot keep that tarball in place of a later stable release of the same version number.

Install one only to try the pull request:

```bash
bun add https://pkg.pr.new/Zhivex/zhivex-ai-sdk/@zhivex-ai/sdk@<pull-request-number>
```

The workflow comment on the pull request lists the exact URLs. Stable and prerelease publishing stays on the protected release workflow described in [RELEASE.md](./RELEASE.md).

## Who can publish a preview

The workflow runs on `pull_request_target`, so GitHub reads it from the default branch. A pull request cannot delete the author check by editing the workflow file. The job runs only when both of these are true:

- `github.event.pull_request.head.repo.full_name == github.repository`, so the head branch is in this repository.
- `github.event.pull_request.author_association` is `OWNER`, `MEMBER`, or `COLLABORATOR`.

Fork pull requests do not get a preview, including when the author is an owner, member, or collaborator. Push the branch into this repository and open the pull request from that branch. Other authors, including contributors and first-time contributors, also skip the job. The workflow does not check out fork code.

The checked-out commit is the pull request head. The workflow sets `permissions: {}`, checks out with `persist-credentials: false`, installs with `--ignore-scripts`, and unsets `GITHUB_TOKEN`, `GH_TOKEN`, `NPM_TOKEN`, and `NODE_AUTH_TOKEN` before install, build, and upload. It must not gain a secret, an OIDC `id-token`, or the `npm` environment.

pkg.pr.new still needs its GitHub App installed on this repository before an upload can succeed. Installing that app is a GitHub setting for a maintainer. This repository does not store a token for it, and this change does not install the app or change settings.
