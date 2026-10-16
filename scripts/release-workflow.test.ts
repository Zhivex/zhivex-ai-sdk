import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
    expect(ciWorkflow).toContain("actions/setup-node@820762786026740c76f36085b0efc47a31fe5020");
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
    const publishJob = jobSection("publish", "collect_tags");

    expect(validateJob).toContain("bun run test");
    expect(validateJob).toContain("bun run build");
    expect(validateJob).toContain("bun run scripts/package-consumer-smoke.ts");
    expect(validateJob).not.toContain("id-token: write");
    expect(publishJob).toContain("needs: validate");
    expect(publishJob).toContain("id-token: write");
    expect(publishJob).not.toContain("actions/checkout");
    expect(publishJob).not.toContain("bun ");
    expect(publishJob).not.toContain("scripts/");
    expect(publishJob).not.toContain("bun run test");
    expect(publishJob).not.toContain("bun run build");
    expect(publishJob).not.toContain("bun install");
  });

  it("publishes only commit-bound tarballs verified with SHA-512", () => {
    expect(workflow).toContain('release-artifacts.ts prepare --git-head="$GITHUB_SHA"');
    expect(workflow).toContain(".release/tarballs/*.tgz");
    const publishJob = jobSection("publish", "collect_tags");
    expect(publishJob).toContain(
      "name: release-source-${{ github.sha }}\n          path: .release"
    );
    expect(publishJob).toContain("shasum -a 512 -c .release/SHA512SUMS");
    expect(publishJob).toContain('"publish"');
    expect(publishJob).toContain('"--provenance"');
    expect(publishJob).not.toContain("release-artifacts.ts publish");
    const scriptStart = publishJob.indexOf("node <<'END_PUBLISH'\n");
    const scriptEnd = publishJob.indexOf("\n          END_PUBLISH", scriptStart);
    const source = publishJob.slice(scriptStart + "node <<'END_PUBLISH'\n".length, scriptEnd).replace(/^ {10}/gm, "");
    const directory = mkdtempSync(path.join(tmpdir(), "zhivex-publish-"));
    const scriptPath = path.join(directory, "publish.cjs");
    writeFileSync(scriptPath, source);
    execFileSync("node", ["--check", scriptPath], { stdio: "pipe" });
    rmSync(directory, { recursive: true, force: true });
    expect(workflow).toContain("shasum -a 512 -c .release/SHA512SUMS");
    expect(jobSection("collect_tags", "push_tags")).toContain('bun scripts/collect-release-tags.ts --git-head="$GITHUB_SHA"');
    expect(jobSection("collect_tags", "push_tags")).not.toContain("id-token:");
    expect(workflow).toContain("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(workflow).toContain("actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c");
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

  it("pins every third-party action to a full commit and uses current security majors", () => {
    const actionReferences = [workflow, ciWorkflow, codeqlWorkflow]
      .flatMap((value) => value.match(/uses:\s+\S+/g) ?? [])
      .map((value) => value.replace(/^uses:\s+/, ""));

    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference).toMatch(/@[a-f0-9]{40}$/);
    }
    expect(codeqlWorkflow).toContain(
      "github/codeql-action/init@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2"
    );
    expect(workflow).toContain(
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
    );
  });

  it("refuses the repository publish command so the OIDC job cannot run it", () => {
    try {
      execFileSync("bun", ["scripts/release-artifacts.ts", "publish", "--tag=latest"], {
        encoding: "utf8",
        stdio: "pipe"
      });
      throw new Error("publish command exited successfully");
    } catch (error) {
      const stderr = String((error as { stderr?: string }).stderr ?? "");
      expect(stderr).toContain("checksum-verified tarballs");
    }
  });
});
