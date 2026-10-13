import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/preview.yml", import.meta.url), "utf8");
const guide = readFileSync(new URL("../docs/maintainers/PR_PREVIEWS.md", import.meta.url), "utf8");

describe("pull request package previews", () => {
  it("publishes pkg.pr.new previews only for members and collaborators", () => {
    expect(workflow).toContain("pull_request_target:");
    expect(workflow).not.toContain("pull_request:");
    expect(workflow).toContain("permissions: {}");
    expect(workflow).toContain('["OWNER","MEMBER","COLLABORATOR"]');
    expect(workflow).not.toContain("CONTRIBUTOR");
    expect(workflow).toContain("ref: ${{ github.event.pull_request.head.sha }}");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("bun install --frozen-lockfile --ignore-scripts");
    expect(workflow).toContain("pkg-pr-new@0.0.91");
    expect(workflow).toContain(
      "pkg-pr-new publish --bun --packageManager=bun --previewVersion --no-template --comment=update './packages/*'"
    );
  });

  it("keeps repository secrets, npm publishing, and provenance out of the preview", () => {
    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toContain("id-token:");
    expect(workflow).not.toContain("NPM_TOKEN:");
    expect(workflow).not.toContain("environment:");
    expect(workflow).not.toContain("npm publish");
    expect(workflow).not.toContain("release.yml");
    expect(workflow).toContain("unset GITHUB_TOKEN GH_TOKEN NPM_TOKEN NODE_AUTH_TOKEN");
    expect(workflow).toContain("they have no npm provenance attestation.");
    expect(guide).toContain("no npm provenance attestation");
    expect(guide).toContain("OWNER");
    expect(guide).toContain("MEMBER");
    expect(guide).toContain("COLLABORATOR");
    expect(guide).toContain("permissions: {}");
  });

  it("pins every third-party action to a full commit", () => {
    const actionReferences = (workflow.match(/uses:\s+\S+/g) ?? [])
      .map((value) => value.replace(/^uses:\s+/, ""));

    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference).toMatch(/@[a-f0-9]{40}$/);
    }
  });
});
