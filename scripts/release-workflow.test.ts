import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const publishScriptSource = () => {
  const publishJob = jobSection("publish", "collect_tags");
  const scriptStart = publishJob.indexOf("node <<'END_PUBLISH'\n");
  const scriptEnd = publishJob.indexOf("\n          END_PUBLISH", scriptStart);
  return publishJob.slice(scriptStart + "node <<'END_PUBLISH'\n".length, scriptEnd).replace(/^ {10}/gm, "");
};

type RegistryFixture = Record<string, { integrity: string; shasum?: string }>;

// Runs the inline publish step against fixture tarballs, a stub npm, and a stub registry.
const runPublishStep = (registry: RegistryFixture) => {
  const directory = mkdtempSync(path.join(tmpdir(), "zhivex-publish-run-"));
  const gitHead = "a".repeat(40);
  const tarballs = path.join(directory, ".release", "tarballs");
  mkdirSync(tarballs, { recursive: true });
  const packages = ["@zhivex-ai/alpha@1.0.0", "@zhivex-ai/beta@2.0.0"].map((identity) => {
    const [, name, version] = /^(@zhivex-ai\/[a-z]+)@(.+)$/.exec(identity) ?? [];
    const tarball = `${name.slice("@zhivex-ai/".length)}-${version}.tgz`;
    const bytes = Buffer.from(`tarball ${identity}`);
    writeFileSync(path.join(tarballs, tarball), bytes);
    return {
      identity,
      entry: { name, version, tarball, sha512: createHash("sha512").update(bytes).digest("hex") },
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      shasum: createHash("sha1").update(bytes).digest("hex")
    };
  });
  writeFileSync(
    path.join(directory, ".release", "release-artifacts.json"),
    JSON.stringify({ schemaVersion: 1, gitHead, packages: packages.map((value) => value.entry) })
  );
  writeFileSync(
    path.join(directory, ".release", "zhivex-release-batch.json"),
    JSON.stringify(packages.map((value) => value.identity))
  );
  const resolved = Object.fromEntries(
    Object.entries(registry).map(([identity, dist]) => {
      const local = packages.find((value) => value.identity === identity);
      return [identity, {
        integrity: dist.integrity === "local" ? local?.integrity : dist.integrity,
        shasum: dist.shasum === "local" ? local?.shasum : dist.shasum
      }];
    })
  );
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  const npmLog = path.join(directory, "npm.log");
  writeFileSync(path.join(bin, "npm"), `#!/bin/sh\necho "$@" >> "${npmLog}"\n`);
  chmodSync(path.join(bin, "npm"), 0o755);
  const preload = path.join(directory, "preload.cjs");
  writeFileSync(preload, [
    `const registry = ${JSON.stringify(resolved)};`,
    "globalThis.setTimeout = (callback) => { callback(); return 0; };",
    "globalThis.fetch = async (url) => {",
    "  const match = /registry\\.npmjs\\.org\\/(.+)\\/([^/]+)$/.exec(String(url));",
    "  const identity = `${decodeURIComponent(match[1])}@${decodeURIComponent(match[2])}`;",
    "  const dist = registry[identity];",
    "  if (!dist) return { status: 404, json: async () => ({}) };",
    "  return { status: 200, json: async () => ({ version: match[2], dist }) };",
    "};"
  ].join("\n"));
  const scriptPath = path.join(directory, "publish.cjs");
  writeFileSync(scriptPath, publishScriptSource());
  const result = spawnSync("node", ["--require", preload, scriptPath], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, RELEASE_TAG: "latest", RELEASE_GIT_HEAD: gitHead }
  });
  const published = existsSync(npmLog) ? readFileSync(npmLog, "utf8").trim().split("\n").filter(Boolean) : [];
  rmSync(directory, { recursive: true, force: true });
  return { status: result.status, output: `${result.stdout}${result.stderr}`, published };
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
    expect(ciWorkflow).toContain("actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1");
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
    expect(jobSection("collect_tags", "push_tags")).toContain("needs: verify_public");
    expect(jobSection("collect_tags", "push_tags")).toContain("needs.verify_public.result == 'success'");
    expect(jobSection("collect_tags", "push_tags")).toContain('bun scripts/collect-release-tags.ts --git-head="$GITHUB_SHA"');
    expect(jobSection("collect_tags", "push_tags")).not.toContain("id-token:");
    expect(jobSection("push_tags", "verify_public")).toContain("needs: collect_tags");
    expect(workflow).toContain("actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9");
    expect(workflow).toContain("actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333");
  });

  it("skips versions npm already holds with identical bytes and publishes the rest", () => {
    const result = runPublishStep({ "@zhivex-ai/alpha@1.0.0": { integrity: "local", shasum: "local" } });

    expect(result.status).toBe(0);
    expect(result.output).toContain("Skipping @zhivex-ai/alpha@1.0.0");
    expect(result.published).toHaveLength(1);
    expect(result.published[0]).toContain("beta-2.0.0.tgz --tag latest --access public --provenance");
    expect(result.output).toContain("Published 1 and skipped 1");
  });

  it("refuses an existing version whose registry bytes differ from the validated tarball", () => {
    const result = runPublishStep({ "@zhivex-ai/alpha@1.0.0": { integrity: "sha512-different" } });

    expect(result.status).toBe(1);
    expect(result.output).toContain("already on npm with different bytes");
    expect(result.published).toEqual([]);
  });

  it("publishes every tarball when none is on npm yet", () => {
    const result = runPublishStep({});

    expect(result.status).toBe(0);
    expect(result.published).toHaveLength(2);
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
      "github/codeql-action/init@6f2ac81f5cd81fe351a197ba0b00d91d03cd2aee"
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
