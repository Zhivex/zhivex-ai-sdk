import { describe, expect, it } from "vitest";

import {
  auditRelease,
  compareVersions,
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
});
