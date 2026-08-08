import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { validateReleaseArtifacts, type ReleaseArtifactManifest } from "./release-artifacts.js";

const gitHead = "a".repeat(40);

describe("release artifacts", () => {
  it("binds an exact release batch and tarball bytes to a commit", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zhivex-release-artifact-"));
    const tarball = "zhivex-ai-core-1.2.3.tgz";
    const contents = Buffer.from("immutable tarball fixture");
    writeFileSync(path.join(directory, tarball), contents);
    const manifest: ReleaseArtifactManifest = {
      schemaVersion: 1,
      gitHead,
      packages: [{
        name: "@zhivex-ai/core",
        version: "1.2.3",
        tarball,
        sha512: createHash("sha512").update(contents).digest("hex")
      }]
    };

    expect(validateReleaseArtifacts({
      manifest,
      batch: ["@zhivex-ai/core@1.2.3"],
      artifactDirectory: directory,
      expectedGitHead: gitHead
    })).toEqual(manifest.packages);
  });

  it("rejects modified tarball bytes", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zhivex-release-artifact-"));
    const tarball = "zhivex-ai-core-1.2.3.tgz";
    writeFileSync(path.join(directory, tarball), "modified");
    const manifest: ReleaseArtifactManifest = {
      schemaVersion: 1,
      gitHead,
      packages: [{
        name: "@zhivex-ai/core",
        version: "1.2.3",
        tarball,
        sha512: "0".repeat(128)
      }]
    };

    expect(() => validateReleaseArtifacts({
      manifest,
      batch: ["@zhivex-ai/core@1.2.3"],
      artifactDirectory: directory,
      expectedGitHead: gitHead
    })).toThrow("checksum mismatch");
  });
});
