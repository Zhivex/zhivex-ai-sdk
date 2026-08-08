import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

const packageIdentityPattern = /^(@zhivex-ai\/[a-z0-9][a-z0-9-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const gitHeadPattern = /^[a-f0-9]{40}$/;
const tarballPattern = /^[a-z0-9][a-z0-9._-]*\.tgz$/;

export interface ReleaseArtifactEntry {
  name: string;
  version: string;
  tarball: string;
  sha512: string;
}

export interface ReleaseArtifactManifest {
  schemaVersion: 1;
  gitHead: string;
  packages: ReleaseArtifactEntry[];
}

interface WorkspacePackage {
  name: string;
  version: string;
  directory: string;
}

const sha512File = (filePath: string) =>
  createHash("sha512").update(readFileSync(filePath)).digest("hex");

const readJson = <T>(filePath: string): T =>
  JSON.parse(readFileSync(filePath, "utf8")) as T;

const loadWorkspacePackages = (repoRoot: string): WorkspacePackage[] =>
  readdirSync(path.join(repoRoot, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = path.join(repoRoot, "packages", entry.name);
      const manifest = readJson<{ name: string; version: string }>(path.join(directory, "package.json"));
      return { ...manifest, directory };
    });

const requireGitHead = (gitHead: string) => {
  if (!gitHeadPattern.test(gitHead)) {
    throw new Error(`Invalid release git head: ${gitHead}`);
  }
};

const requireReleaseBatch = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !packageIdentityPattern.test(entry))) {
    throw new Error("Release batch must contain only validated @zhivex-ai package identities.");
  }
  if (new Set(value).size !== value.length) {
    throw new Error("Release batch contains duplicate package identities.");
  }
  return [...value].sort();
};

export const prepareReleaseArtifacts = ({
  repoRoot,
  batchFile,
  outputDirectory,
  gitHead
}: {
  repoRoot: string;
  batchFile: string;
  outputDirectory: string;
  gitHead: string;
}): ReleaseArtifactManifest => {
  requireGitHead(gitHead);
  const batch = requireReleaseBatch(readJson<unknown>(batchFile));
  const workspace = new Map(
    loadWorkspacePackages(repoRoot).map((pkg) => [`${pkg.name}@${pkg.version}`, pkg])
  );
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const npmCacheDirectory = path.join(path.dirname(outputDirectory), "npm-cache");
  mkdirSync(npmCacheDirectory, { recursive: true, mode: 0o700 });
  if (readdirSync(outputDirectory).length > 0) {
    throw new Error(`Release artifact directory must be empty: ${outputDirectory}`);
  }

  const packages = batch.map((identity): ReleaseArtifactEntry => {
    const pkg = workspace.get(identity);
    if (!pkg) {
      throw new Error(`Release batch package does not match the workspace: ${identity}`);
    }
    const output = execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", outputDirectory, pkg.directory],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
        env: {
          ...process.env,
          NPM_CONFIG_CACHE: npmCacheDirectory,
          NPM_CONFIG_AUDIT: "false",
          NPM_CONFIG_FUND: "false",
          NPM_CONFIG_UPDATE_NOTIFIER: "false"
        }
      }
    );
    const packed = readPackedResult(output);
    if (packed.name !== pkg.name || packed.version !== pkg.version || !tarballPattern.test(packed.filename)) {
      throw new Error(`npm pack returned unexpected metadata for ${identity}.`);
    }
    const tarballPath = path.join(outputDirectory, packed.filename);
    if (!statSync(tarballPath).isFile()) {
      throw new Error(`npm pack did not create a regular tarball for ${identity}.`);
    }
    return {
      name: pkg.name,
      version: pkg.version,
      tarball: packed.filename,
      sha512: sha512File(tarballPath)
    };
  });

  const manifest: ReleaseArtifactManifest = {
    schemaVersion: 1,
    gitHead,
    packages
  };
  writeFileSync(
    path.join(path.dirname(outputDirectory), "release-artifacts.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 }
  );
  return manifest;
};

const readPackedResult = (output: string) => {
  const results = JSON.parse(output) as Array<{ name?: string; version?: string; filename?: string }>;
  const result = results[0];
  if (results.length !== 1 || !result?.name || !result.version || !result.filename) {
    throw new Error("npm pack returned an invalid JSON result.");
  }
  return result as { name: string; version: string; filename: string };
};

export const validateReleaseArtifacts = ({
  manifest,
  batch,
  artifactDirectory,
  expectedGitHead
}: {
  manifest: ReleaseArtifactManifest;
  batch: unknown;
  artifactDirectory: string;
  expectedGitHead: string;
}): ReleaseArtifactEntry[] => {
  requireGitHead(expectedGitHead);
  if (manifest.schemaVersion !== 1 || manifest.gitHead !== expectedGitHead || !Array.isArray(manifest.packages)) {
    throw new Error("Release artifact manifest is not bound to the expected commit.");
  }
  const expectedBatch = requireReleaseBatch(batch);
  const resolvedArtifactDirectory = path.resolve(artifactDirectory);
  const entries = manifest.packages.map((entry) => {
    const identity = `${entry.name}@${entry.version}`;
    if (!packageIdentityPattern.test(identity) || !tarballPattern.test(entry.tarball)) {
      throw new Error(`Invalid release artifact entry: ${identity}`);
    }
    if (!/^[a-f0-9]{128}$/.test(entry.sha512)) {
      throw new Error(`Invalid SHA-512 digest for ${identity}.`);
    }
    const tarballPath = path.resolve(resolvedArtifactDirectory, entry.tarball);
    if (path.dirname(tarballPath) !== resolvedArtifactDirectory) {
      throw new Error(`Release tarball escapes its artifact directory: ${entry.tarball}`);
    }
    const tarballStat = lstatSync(tarballPath);
    if (!tarballStat.isFile() || tarballStat.isSymbolicLink()) {
      throw new Error(`Release tarball must be a regular file: ${entry.tarball}`);
    }
    if (sha512File(tarballPath) !== entry.sha512) {
      throw new Error(`Release tarball checksum mismatch: ${entry.tarball}`);
    }
    return entry;
  });
  const actualBatch = entries.map((entry) => `${entry.name}@${entry.version}`).sort();
  if (JSON.stringify(actualBatch) !== JSON.stringify(expectedBatch)) {
    throw new Error("Release artifact manifest does not match the selected release batch.");
  }
  if (new Set(entries.map((entry) => entry.tarball)).size !== entries.length) {
    throw new Error("Release artifact manifest contains duplicate tarballs.");
  }
  return entries;
};

const argument = (name: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);

const run = () => {
  const command = process.argv[2];
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const releaseDirectory = path.join(repoRoot, ".release");
  const batchFile = path.join(releaseDirectory, "zhivex-release-batch.json");
  const artifactDirectory = path.join(releaseDirectory, "tarballs");
  const gitHead = argument("git-head") ?? process.env.GITHUB_SHA ?? "";

  if (command === "prepare") {
    const manifest = prepareReleaseArtifacts({ repoRoot, batchFile, outputDirectory: artifactDirectory, gitHead });
    console.log(`Prepared ${manifest.packages.length} immutable release tarball(s).`);
    return;
  }
  if (command === "publish") {
    if (
      process.env.GITHUB_ACTIONS !== "true" ||
      !process.env.ACTIONS_ID_TOKEN_REQUEST_URL ||
      !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    ) {
      throw new Error("Publishing requires GitHub Actions trusted publishing with OIDC.");
    }
    const tag = argument("tag") ?? "latest";
    if (tag !== "latest" && tag !== "next") {
      throw new Error(`Unsupported release tag: ${tag}`);
    }
    const entries = validateReleaseArtifacts({
      manifest: readJson<ReleaseArtifactManifest>(path.join(releaseDirectory, "release-artifacts.json")),
      batch: readJson<unknown>(batchFile),
      artifactDirectory,
      expectedGitHead: gitHead
    });
    for (const entry of entries) {
      execFileSync(
        "npm",
        ["publish", path.join(artifactDirectory, entry.tarball), "--tag", tag, "--access", "public", "--provenance"],
        { cwd: repoRoot, stdio: "inherit" }
      );
    }
    console.log(`Published ${entries.length} verified release tarball(s) with dist-tag ${tag}.`);
    return;
  }
  throw new Error("Usage: release-artifacts.ts prepare|publish [--tag=latest|next] [--git-head=<sha>]");
};

if (import.meta.main) {
  run();
}
