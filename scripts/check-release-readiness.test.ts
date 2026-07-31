import { describe, expect, it } from "vitest";

import {
  auditRelease,
  compareVersions,
  releaseOidcErrors,
  releaseWorktreeErrors,
  verifyReleaseWithRetry,
  type PackageManifest,
  type RegistryDocument
} from "./check-release-readiness";

const packages: PackageManifest[] = [
  { name: "@zhivex-ai/core", version: "0.16.1" },
  {
    name: "@zhivex-ai/sdk",
    version: "0.15.1",
    dependencies: { "@zhivex-ai/core": "^0.16.1" }
  }
];

const releaseGitHead = "0123456789abcdef0123456789abcdef01234567";
const publishedVersion = (
  value: Omit<NonNullable<RegistryDocument["versions"]>[string], "gitHead" | "dist"> = {}
) => ({
  ...value,
  gitHead: releaseGitHead,
  dist: {
    integrity: `sha512-${"A".repeat(86)}==`,
    attestations: {
      url: "https://registry.npmjs.org/-/npm/v1/attestations/example",
      provenance: {
        predicateType: "https://slsa.dev/provenance/v1"
      }
    }
  }
});

const registry: Record<string, RegistryDocument> = {
  "@zhivex-ai/core": {
    versions: { "0.15.1": {}, "0.16.0": {} },
    "dist-tags": { latest: "0.15.1" }
  },
  "@zhivex-ai/sdk": {
    versions: {
      "0.15.0": { dependencies: { "@zhivex-ai/core": "^0.16.0" } }
    },
    "dist-tags": { latest: "0.15.0" }
  }
};

describe("release readiness", () => {
  it("compares stable and prerelease versions without a runtime-specific semver API", () => {
    expect(compareVersions("0.16.1", "0.16.0")).toBe(1);
    expect(compareVersions("0.16.0-rc.0", "0.16.0")).toBe(-1);
  });

  it("accepts a coherent pending batch that repairs a regressed latest tag", () => {
    const audit = auditRelease("main", packages, registry);

    expect(audit.errors).toEqual([]);
    expect(audit.pending).toEqual(["@zhivex-ai/core@0.16.1", "@zhivex-ai/sdk@0.15.1"]);
    expect(audit.warnings).toContain(
      "@zhivex-ai/core: latest is 0.15.1, highest published is 0.16.0; publishing 0.16.1 will repair the tag."
    );
  });

  it("rejects publishing from a feature branch", () => {
    const audit = auditRelease("new-openai-models", packages, registry);

    expect(audit.errors).toContain(
      "Releases must run from main; current branch is new-openai-models."
    );
  });

  it("rejects an unresolved internal release dependency", () => {
    const incompatible = packages.map((manifest) =>
      manifest.name === "@zhivex-ai/sdk"
        ? { ...manifest, dependencies: { "@zhivex-ai/core": "^0.17.0" } }
        : manifest
    );

    const audit = auditRelease("main", incompatible, registry);

    expect(audit.errors).toContain(
      "@zhivex-ai/sdk: @zhivex-ai/core ^0.17.0 does not accept the local release version 0.16.1."
    );
  });

  it("rejects a stale latest tag when no higher local version will repair it", () => {
    const noPendingCore = packages.map((manifest) =>
      manifest.name === "@zhivex-ai/core" ? { ...manifest, version: "0.16.0" } : manifest
    );

    const audit = auditRelease("main", noPendingCore, registry);

    expect(audit.errors).toContain(
      "@zhivex-ai/core: latest points to 0.15.1, but the highest published stable version is 0.16.0."
    );
  });

  it("requires every local version to exist after publishing", () => {
    const audit = auditRelease("main", packages, registry, "postpublish");

    expect(audit.errors).toContain("@zhivex-ai/core@0.16.1 is still missing from npm after publish.");
    expect(audit.errors).toContain("@zhivex-ai/sdk@0.15.1 is still missing from npm after publish.");
  });

  it("requires latest to point to each stable version after publishing", () => {
    const publishedRegistry: Record<string, RegistryDocument> = {
      "@zhivex-ai/core": {
        versions: { "0.16.1": publishedVersion() },
        "dist-tags": { latest: "0.16.0" }
      },
      "@zhivex-ai/sdk": {
        versions: {
          "0.15.1": publishedVersion({
            dependencies: { "@zhivex-ai/core": "^0.16.1" }
          })
        },
        "dist-tags": { latest: "0.15.0" }
      }
    };

    const audit = auditRelease(
      "main",
      packages,
      publishedRegistry,
      "postpublish",
      "latest",
      releaseGitHead
    );

    expect(audit.errors).toContain(
      "@zhivex-ai/core@0.16.1: npm dist-tag latest points to 0.16.0."
    );
    expect(audit.errors).toContain(
      "@zhivex-ai/sdk@0.15.1: npm dist-tag latest points to 0.15.0."
    );
  });

  it("retries postpublish verification while npm registry propagation is incomplete", async () => {
    const publishedRegistry: Record<string, RegistryDocument> = {
      "@zhivex-ai/core": {
        versions: { "0.16.1": publishedVersion() },
        "dist-tags": { latest: "0.16.1" }
      },
      "@zhivex-ai/sdk": {
        versions: {
          "0.15.1": publishedVersion({
            dependencies: { "@zhivex-ai/core": "^0.16.1" }
          })
        },
        "dist-tags": { latest: "0.15.1" }
      }
    };
    let registryReads = 0;
    const retryMessages: string[] = [];

    const audit = await verifyReleaseWithRetry({
      branch: "main",
      packages,
      mode: "postpublish",
      distTag: "latest",
      loadRegistry: async () => {
        registryReads += 1;
        return registryReads === 1 ? registry : publishedRegistry;
      },
      maxAttempts: 3,
      retryDelayMs: 0,
      sleep: async () => {},
      onRetry: (message) => retryMessages.push(message),
      expectedGitHead: releaseGitHead
    });

    expect(registryReads).toBe(2);
    expect(retryMessages).toHaveLength(1);
    expect(audit).toEqual({ errors: [], pending: [], warnings: [] });
  });

  it("rejects prerelease versions on latest and stable versions on next", () => {
    const prereleasePackages = packages.map((manifest) => ({ ...manifest, version: `${manifest.version}-next.0` }));

    expect(auditRelease("main", prereleasePackages, registry).errors).toContain(
      "@zhivex-ai/core@0.16.1-next.0: prerelease versions must use an explicit non-latest dist-tag."
    );
    expect(auditRelease("main", packages, registry, "prepublish", "next").errors).toContain(
      "@zhivex-ai/core@0.16.1: stable versions must publish to the latest dist-tag."
    );
  });

  it("requires committed source and an OIDC publishing environment", () => {
    expect(releaseWorktreeErrors(" M packages/core/src/index.ts\n")).toEqual([
      "Release source must be committed: the worktree contains tracked or untracked changes."
    ]);
    expect(releaseWorktreeErrors("")).toEqual([]);
    expect(releaseOidcErrors({ GITHUB_ACTIONS: "true" })).toHaveLength(1);
    expect(releaseOidcErrors({
      GITHUB_ACTIONS: "true",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "ephemeral"
    })).toEqual([]);
  });

  it("verifies the explicit prerelease dist-tag after publishing", () => {
    const prereleasePackage: PackageManifest[] = [
      { name: "@zhivex-ai/core", version: "0.17.0-next.0" }
    ];
    const prereleaseRegistry: Record<string, RegistryDocument> = {
      "@zhivex-ai/core": {
        versions: { "0.17.0-next.0": publishedVersion() },
        "dist-tags": { latest: "0.16.1", next: "0.16.2-next.0" }
      }
    };

    expect(auditRelease(
      "main",
      prereleasePackage,
      prereleaseRegistry,
      "postpublish",
      "next",
      releaseGitHead
    ).errors).toContain(
      "@zhivex-ai/core@0.17.0-next.0: npm dist-tag next points to 0.16.2-next.0."
    );
  });

  it("requires integrity, trusted publishing provenance, and the release commit after publishing", () => {
    const insecureRegistry: Record<string, RegistryDocument> = {
      "@zhivex-ai/core": {
        versions: {
          "0.16.1": {
            gitHead: "ffffffffffffffffffffffffffffffffffffffff",
            dist: {
              integrity: "sha1-insecure",
              attestations: {
                url: "https://attacker.example/forged-attestation",
                provenance: {
                  predicateType: "https://slsa.dev/provenance/v1"
                }
              }
            }
          }
        },
        "dist-tags": { latest: "0.16.1" }
      },
      "@zhivex-ai/sdk": {
        versions: {
          "0.15.1": publishedVersion({
            dependencies: { "@zhivex-ai/core": "^0.16.1" }
          })
        },
        "dist-tags": { latest: "0.15.1" }
      }
    };

    const audit = auditRelease(
      "main",
      packages,
      insecureRegistry,
      "postpublish",
      "latest",
      releaseGitHead
    );

    expect(audit.errors).toContain(
      "@zhivex-ai/core@0.16.1: npm metadata is missing a sha512 integrity digest."
    );
    expect(audit.errors).toContain(
      "@zhivex-ai/core@0.16.1: npm metadata is missing a trusted publishing provenance attestation."
    );
    expect(audit.errors).toContain(
      "@zhivex-ai/core@0.16.1: npm gitHead ffffffffffffffffffffffffffffffffffffffff; expected 0123456789abcdef0123456789abcdef01234567."
    );
  });
});
