import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8"
);
const ciWorkflow = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8"
);
const codeqlWorkflow = readFileSync(
  new URL("../.github/workflows/codeql.yml", import.meta.url),
  "utf8"
);

const jobSection = (name: string, nextName: string) => {
  const start = workflow.indexOf(`  ${name}:`);
  const end = workflow.indexOf(`  ${nextName}:`, start + 1);
  return workflow.slice(start, end === -1 ? undefined : end);
};

describe("release workflow", () => {
  it("recovers published tags from npm metadata and passes them as single-line JSON", () => {
    expect(workflow).toContain("release_tags_json:");
    expect(workflow).toContain("has_release_tags:");
    expect(workflow).toContain('bun scripts/collect-release-tags.ts --git-head="$GITHUB_SHA"');
    expect(workflow).toContain('echo "tags_json=$tags_json"');
    expect(workflow).toContain("jq -r '.[]'");
    expect(workflow).not.toContain("tags-before");
    expect(workflow).not.toContain("comm -13");
  });

  it("tests packed packages through Node in CI and before publishing", () => {
    expect(ciWorkflow).toContain("actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38");
    expect(ciWorkflow).toContain("bun run scripts/package-consumer-smoke.ts");
    expect(workflow).toContain("bun run scripts/package-consumer-smoke.ts");
  });

  it("creates the aggregate SDK GitHub release after pushing tags", () => {
    expect(workflow).toContain("gh release create");
    expect(workflow).toContain("--verify-tag");
    expect(workflow).toContain("--generate-notes");
  });

  it("accepts existing annotated tags only when they resolve to the release commit", () => {
    expect(workflow).toContain('refs/tags/$tag^{}');
    expect(workflow).toContain('tag -a "$tag" "$GITHUB_SHA" -m "$tag"');
  });

  it("uses immutable installs, an audit gate, OIDC, and bounded jobs", () => {
    expect(workflow).toContain("bun install --frozen-lockfile --ignore-scripts");
    expect(workflow).toContain("bun audit");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("timeout-minutes:");
  });

  it("keeps validation outside the npm OIDC trust boundary", () => {
    const validateJob = jobSection("validate", "publish");
    const publishJob = jobSection("publish", "push_tags");

    expect(validateJob).toContain("bun run test");
    expect(validateJob).toContain("bun run build");
    expect(validateJob).toContain("bun run scripts/package-consumer-smoke.ts");
    expect(validateJob).not.toContain("id-token: write");
    expect(publishJob).toContain("needs: validate");
    expect(publishJob).toContain("id-token: write");
    expect(publishJob).not.toContain("bun run test");
    expect(publishJob).not.toContain("bun run build");
    expect(publishJob).not.toContain("bun install");
  });

  it("publishes only commit-bound tarballs verified with SHA-512", () => {
    expect(workflow).toContain('release-artifacts.ts prepare --git-head="$GITHUB_SHA"');
    expect(workflow).toContain(".release/tarballs/*.tgz");
    expect(jobSection("publish", "push_tags")).toContain(
      "name: release-source-${{ github.sha }}\n          path: .release"
    );
    expect(workflow).toContain("shasum -a 512 -c .release/SHA512SUMS");
    expect(workflow).toContain('release-artifacts.ts publish --tag=latest --git-head="$GITHUB_SHA"');
    expect(workflow).toContain('release-artifacts.ts publish --tag=next --git-head="$GITHUB_SHA"');
    expect(workflow).toContain("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");
    expect(workflow).toContain("actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093");
  });

  it("runs the repository-pinned secret scanner in CI and release validation", () => {
    expect(ciWorkflow).toContain("bun run scripts/scan-secrets.ts");
    expect(jobSection("validate", "publish")).toContain("bun run scripts/scan-secrets.ts");
  });

  it("pins every third-party action to a full commit and uses current security majors", () => {
    const actionReferences = [workflow, ciWorkflow, codeqlWorkflow]
      .flatMap((value) => value.match(/uses:\s+\S+/g) ?? [])
      .map((value) => value.replace(/^uses:\s+/, ""));

    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference).toMatch(/@[a-f0-9]{40}$/);
    }
    expect(codeqlWorkflow).toContain(
      "github/codeql-action/init@f205ea1c3313d32999d8d6a48b4f6530d4437b38"
    );
    expect(workflow).toContain(
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
    );
  });
});
