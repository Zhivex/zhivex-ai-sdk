import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  fetchNpmProvenanceEvidence,
  releaseCommitEvidenceMatches,
  type NpmProvenanceManifest
} from "./npm-provenance.js";

export interface ReleaseTagPackage {
  name: string;
  version: string;
}

export interface ReleaseTagRegistryDocument {
  versions?: Record<string, {
    gitHead?: string;
    provenanceGitHead?: string;
    dist?: NpmProvenanceManifest;
  }>;
}

const packageNamePattern = /^@zhivex-ai\/[a-z0-9][a-z0-9-]*$/;
const packageVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const gitHeadPattern = /^[a-f0-9]{40}$/;

export const collectReleaseTags = (
  packages: ReleaseTagPackage[],
  registryByName: Record<string, ReleaseTagRegistryDocument>,
  expectedGitHead: string
) => {
  if (!gitHeadPattern.test(expectedGitHead)) {
    throw new Error(`Invalid release git head: ${expectedGitHead}`);
  }

  return packages
    .map((manifest) => {
      if (!packageNamePattern.test(manifest.name) || !packageVersionPattern.test(manifest.version)) {
        throw new Error(`Invalid workspace package identity: ${manifest.name}@${manifest.version}`);
      }
      const publishedVersion = registryByName[manifest.name]?.versions?.[manifest.version];
      return publishedVersion && releaseCommitEvidenceMatches(
        expectedGitHead,
        publishedVersion.gitHead,
        publishedVersion.provenanceGitHead
      )
        ? `${manifest.name}@${manifest.version}`
        : undefined;
    })
    .filter((tag): tag is string => Boolean(tag))
    .sort();
};

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = resolve(scriptDirectory, "..");

const loadWorkspacePackages = (): ReleaseTagPackage[] =>
  readdirSync(join(workspaceDirectory, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) =>
      JSON.parse(
        readFileSync(join(workspaceDirectory, "packages", entry.name, "package.json"), "utf8")
      ) as ReleaseTagPackage
    )
    .sort((left, right) => left.name.localeCompare(right.name));

const loadRegistryDocument = async (
  manifest: ReleaseTagPackage,
  expectedGitHead: string
): Promise<ReleaseTagRegistryDocument> => {
  const registry = (process.env.NPM_CONFIG_REGISTRY ?? "https://registry.npmjs.org").replace(/\/$/, "");
  const response = await fetch(`${registry}/${encodeURIComponent(manifest.name)}?cacheBust=${Date.now()}`, {
    cache: "no-store",
    headers: { accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(`${manifest.name}: registry request failed with HTTP ${response.status}.`);
  }
  const document = await response.json() as ReleaseTagRegistryDocument;
  const publishedVersion = document.versions?.[manifest.version];
  const shouldVerifyProvenance = publishedVersion?.dist?.attestations?.url && (
    !publishedVersion.gitHead || publishedVersion.gitHead === expectedGitHead
  );
  if (publishedVersion?.dist && shouldVerifyProvenance) {
    publishedVersion.provenanceGitHead = (
      await fetchNpmProvenanceEvidence({
        packageName: manifest.name,
        version: manifest.version,
        manifest: publishedVersion.dist
      })
    ).gitCommit;
  }
  return document;
};

const run = async () => {
  const gitHead = process.argv.find((argument) => argument.startsWith("--git-head="))?.slice("--git-head=".length);
  if (!gitHead) {
    throw new Error("Usage: collect-release-tags.ts --git-head=<40-character commit SHA>");
  }

  const packages = loadWorkspacePackages();
  const registryEntries = await Promise.all(
    packages.map(async (manifest) => [
      manifest.name,
      await loadRegistryDocument(manifest, gitHead)
    ] as const)
  );
  const tags = collectReleaseTags(packages, Object.fromEntries(registryEntries), gitHead);
  process.stdout.write(JSON.stringify(tags));
};

if (import.meta.main) {
  await run();
}
