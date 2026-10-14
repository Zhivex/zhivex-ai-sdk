import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflowsDirectory = new URL("../.github/workflows/", import.meta.url);
const workflowSources = Object.fromEntries(
  readdirSync(workflowsDirectory)
    .filter((name) => name.endsWith(".yml"))
    .sort()
    .map((name) => [name, readFileSync(new URL(name, workflowsDirectory), "utf8")])
);

const workflow = workflowSources["release.yml"];
const ciWorkflow = workflowSources["ci.yml"];
const codeqlWorkflow = workflowSources["codeql.yml"];
const previewWorkflow = workflowSources["preview.yml"];
const versionWorkflow = workflowSources["version-packages.yml"];
const agentsGuide = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
const releaseGuide = readFileSync(new URL("../docs/maintainers/RELEASE.md", import.meta.url), "utf8");

const actionUse = (source: string, action: string) =>
  source.match(new RegExp(String.raw`uses:\s+${action.replaceAll("/", "\\/")}@[a-f0-9]{40}\s+#\s+v\d\S*`))?.[0];

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
    expect(ciWorkflow).toContain("node-version: 24");
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
    expect(workflow).toContain("actions/upload-artifact@");
    expect(workflow).toContain("actions/download-artifact@");
  });

  it("publishes each channel with npm publish --tag and does not move dist-tags", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
    };
    const verifyJob = jobSection("verify_public", "missing");

    expect(workflow).not.toContain("align_next");
    expect(workflow).not.toContain("dist-tag add");
    expect(workflow).not.toContain("npm install -g npm@11.21.0");
    expect(workflow).not.toContain("--apply");
    expect(workflow.match(/id-token:\s*write/g)).toEqual(["id-token: write"]);
    expect(workflow.match(/environment:\s*npm/g)).toEqual(["environment: npm"]);
    expect(packageJson.scripts.release).toBeUndefined();
    expect(packageJson.scripts["release:next"]).toBeUndefined();
    expect(verifyJob).toContain("needs: publish");
    expect(verifyJob).toContain("contents: read");
    expect(verifyJob).not.toContain("id-token:");
    expect(verifyJob).not.toContain("environment:");
    expect(verifyJob).not.toContain("NPM_TOKEN");
    expect(verifyJob).not.toContain("npm publish");
    expect(verifyJob).toContain(
      "check-release-readiness.ts --postpublish --tag=${{ inputs.channel }} --release-batch-file=.release/zhivex-release-batch.json"
    );
    expect(verifyJob).toContain(
      "install-published-release.ts --release-batch-file=.release/zhivex-release-batch.json"
    );
    expect(verifyJob).toContain("bun run scripts/align-next-dist-tag.ts");
  });

  it("runs the repository-pinned secret scanner in CI and release validation", () => {
    expect(ciWorkflow).toContain("bun run scripts/scan-secrets.ts");
    expect(jobSection("validate", "publish")).toContain("bun run scripts/scan-secrets.ts");
  });

  it("pins every action in every workflow to a full commit and a version comment", () => {
    expect(Object.keys(workflowSources)).toEqual(
      expect.arrayContaining([
        "ci.yml",
        "codeql.yml",
        "preview.yml",
        "release.yml",
        "version-packages.yml"
      ])
    );

    for (const [fileName, source] of Object.entries(workflowSources)) {
      const usesLines = source.split("\n").filter((line) => /^\s*-\s+uses:/.test(line) || /^\s*uses:/.test(line));
      expect(usesLines.length, fileName).toBeGreaterThan(0);
      for (const line of usesLines) {
        expect(line, `${fileName}: ${line.trim()}`).toMatch(/uses:\s+\S+@[a-f0-9]{40}\s+#\s+v\d/);
      }
    }
  });

  it("keeps preview triggers and permissions free of secrets", () => {
    expect(previewWorkflow).toContain("pull_request_target:");
    expect(previewWorkflow).toContain("permissions: {}");
    expect(previewWorkflow).not.toContain("secrets.");
    expect(previewWorkflow).not.toContain("id-token:");
    expect(previewWorkflow).not.toContain("NPM_TOKEN:");
  });

  it("opens a Version packages pull request without publishing", () => {
    expect(versionWorkflow).toContain("workflow_dispatch:");
    expect(versionWorkflow).toMatch(/push:\n\s+branches:\n\s+- main/);
    expect(versionWorkflow).not.toContain("pull_request:");
    expect(versionWorkflow).not.toContain("pull_request_target:");
    expect(versionWorkflow).toContain("permissions: {}");
    expect(versionWorkflow).toContain("contents: write");
    expect(versionWorkflow).toContain("pull-requests: write");
    expect(versionWorkflow).not.toContain("id-token:");
    expect(versionWorkflow).not.toContain("environment:");
    expect(versionWorkflow).not.toContain("NPM_TOKEN");
    expect(versionWorkflow).not.toContain("npm publish");
    expect(versionWorkflow).not.toMatch(/^\s+publish:/m);
    expect(versionWorkflow).toContain("if: github.repository == 'Zhivex/zhivex-ai-sdk'");
    expect(versionWorkflow).toContain("group: version-packages");
    expect(versionWorkflow).toContain("cancel-in-progress: false");
    expect(versionWorkflow).toContain("::notice title=Version packages skipped::");
    expect(versionWorkflow).toContain("vars.RELEASE_APP_ID");
    expect(versionWorkflow).toContain("secrets.RELEASE_APP_KEY");
    expect(versionWorkflow).toContain("configured=false");
    expect(versionWorkflow).toContain("steps.release-app.outputs.configured == 'true'");
    expect(versionWorkflow).not.toMatch(/exit 1/);
    expect(versionWorkflow).toContain("actions/create-github-app-token@");
    expect(versionWorkflow).toContain("app-id: ${{ vars.RELEASE_APP_ID }}");
    expect(versionWorkflow).toContain("private-key: ${{ secrets.RELEASE_APP_KEY }}");
    expect(versionWorkflow).toContain("fetch-depth: 0");
    expect(versionWorkflow).toContain("persist-credentials: true");
    expect(versionWorkflow).toContain("token: ${{ steps.app-token.outputs.token }}");
    expect(versionWorkflow).toContain("node-version: 24");
    expect(versionWorkflow).toContain("bun-version: 1.4.2");
    expect(versionWorkflow).toContain("bun install --frozen-lockfile --ignore-scripts");
    expect(versionWorkflow).toContain("version-script: bun run version-packages");
    expect(versionWorkflow).toContain("pr-title: Version packages");
    expect(versionWorkflow).toContain("commit-message: Version packages");
    expect(versionWorkflow).toContain("github-token: ${{ steps.app-token.outputs.token }}");
    expect(versionWorkflow).toContain("GITHUB_TOKEN: ${{ steps.app-token.outputs.token }}");
    expect(versionWorkflow).not.toMatch(/^\s+publish-script:/m);
    expect(versionWorkflow).not.toMatch(/^\s+version:\s+bun run/m);
    expect(versionWorkflow).not.toMatch(/^\s+title:\s+Version packages/m);
    expect(versionWorkflow).not.toMatch(/^\s+commit:\s+Version packages/m);
    expect(actionUse(versionWorkflow, "changesets/action")).toMatch(/#\s+v(?:[2-9]|\d{2,})/);
    expect(actionUse(versionWorkflow, "actions/checkout")).toBe(actionUse(ciWorkflow, "actions/checkout"));
    expect(actionUse(versionWorkflow, "actions/setup-node")).toBe(actionUse(ciWorkflow, "actions/setup-node"));
    expect(actionUse(versionWorkflow, "oven-sh/setup-bun")).toBe(actionUse(ciWorkflow, "oven-sh/setup-bun"));
    expect(actionUse(codeqlWorkflow, "github/codeql-action/init")).toMatch(/#\s+v\d/);
    expect(actionUse(codeqlWorkflow, "github/codeql-action/analyze")).toBe(
      actionUse(codeqlWorkflow, "github/codeql-action/init")?.replace("/init@", "/analyze@")
    );
  });

  it("documents the manual publish path and the one-time release app", () => {
    for (const guide of [agentsGuide, releaseGuide]) {
      expect(guide).toContain("Version packages");
      expect(guide).toContain("RELEASE_APP_ID");
      expect(guide).toContain("RELEASE_APP_KEY");
      expect(guide).toContain("workflow_dispatch");
      expect(guide).toContain("Contents");
      expect(guide).toContain("Pull requests");
      expect(guide).toContain("Metadata");
      expect(guide).toMatch(/only on (this repository|`Zhivex\/zhivex-ai-sdk`)/);
    }
    expect(releaseGuide).toContain(".github/workflows/version-packages.yml");
    expect(agentsGuide).toContain("Publishing stays manual");
    expect(releaseGuide).toContain("Publishing stays manual");
  });
});
