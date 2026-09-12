# September 2026 dependency update

Direct dependencies target stable registry releases verified on September 12, 2026. Internal workspace versions and supported peer ranges remain managed separately through Changesets.

## Toolchain

- The repository uses Bun 1.4.2, TypeScript 7.0.2, Vitest 5.0.0 and Changesets 3.0.2. Its Node.js minimum is now 22.12 to satisfy the updated development tools.
- [TypeScript 7](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/) provides the native compiler. Tests that inspect the JavaScript compiler API use the official `@typescript/typescript6` compatibility package. Declaration snapshots were reviewed for equivalent alias emission.
- [Changesets 3](https://github.com/changesets/changesets/releases/tag/%40changesets%2Fcli%403.0.0) uses `@changesets/changelog-git`. Its dependency graph no longer needs the old `read-yaml-file` patch.
- Next.js 16.3.5 uses the [TypeScript CLI integration](https://nextjs.org/docs/app/api-reference/config/next-config-js/useTypeScriptCli) by default, including TypeScript 7.

## Consumer impact

- Bedrock's AWS SDK update requires Node.js 20 or newer; Vertex's Google Auth Library update requires Node.js 22 or newer. Both runtime floor changes have major Changesets.
- Zod 4.6.3 enforces JSON Schema `uniqueItems`, `minProperties`, `maxProperties`, `contains`, `minContains` and `maxContains` when validating MCP tool output. Six regression cases cover valid and invalid values. Previously accepted invalid output can now raise a validation error.
- OpenTelemetry development and Node 24 consumer checks use 2.11.0. The legacy Node 18 consumer leg retains its compatible OpenTelemetry version.

## Compatibility exceptions

- `@types/node` remains at stable 26.5.1: the registry's `latest` tag points to the older 22.20.2 release. Downgrading the existing stable type package is unnecessary.
- Transitive dependencies follow their parents' supported ranges. In particular, PostCSS uses maintained Nano ID 3.x; forcing Nano ID 6 globally would bypass its declared contract. Obsolete Nano ID and js-yaml overrides were removed.
- Existing React and other peer ranges continue to describe supported consumers; updating development fixtures does not require forcing every consumer to the latest major.

Publishing remains a separate protected GitHub workflow action after review and package versioning.

## Local verification

The update passed 1,733 tests, typechecking, documentation checks, a frozen-lockfile clean installation and build, installation of candidate tarballs with 42 entrypoint imports, deterministic agent smoke, SQLite certification and the workflow evaluation gate. The dependency audit reported no vulnerabilities across 235 packages. Changesets 3 generated versions and changelogs successfully in a disposable copy; package versions in this branch have not been advanced.

These checks do not certify remote CI, live provider calls or npm publication.

The standalone Next.js 16.3.5 starter also passed an independent npm installation and production build, including TypeScript 7 checking and static page generation. npm completed the download after the initial Bun download stalled; the monorepo clean-install gate used Bun 1.4.2 successfully.
