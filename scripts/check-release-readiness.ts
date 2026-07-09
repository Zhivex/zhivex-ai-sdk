import { execFileSync } from "node:child_process";

type DependencyMap = Record<string, string>;

export interface PackageManifest {
  name: string;
  version: string;
  dependencies?: DependencyMap;
  peerDependencies?: DependencyMap;
  optionalDependencies?: DependencyMap;
}

export interface RegistryVersion {
  dependencies?: DependencyMap;
  peerDependencies?: DependencyMap;
  optionalDependencies?: DependencyMap;
}

export interface RegistryDocument {
  versions?: Record<string, RegistryVersion>;
  "dist-tags"?: Record<string, string>;
}

export interface ReleaseAudit {
  errors: string[];
  pending: string[];
  warnings: string[];
}

const internalPrefix = "@zhivex-ai/";

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

const parseVersion = (version: string): ParsedVersion => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) {
    throw new Error(`Unsupported semver version: ${version}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]
  };
};

export const compareVersions = (left: string, right: string) => {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const field of ["major", "minor", "patch"] as const) {
    if (a[field] !== b[field]) {
      return a[field] < b[field] ? -1 : 1;
    }
  }
  if (a.prerelease === b.prerelease) {
    return 0;
  }
  if (a.prerelease === undefined) {
    return 1;
  }
  if (b.prerelease === undefined) {
    return -1;
  }
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true });
};

const satisfiesVersion = (version: string, range: string) => {
  if (range === "*" || range === "latest") {
    return true;
  }
  if (range.startsWith("^")) {
    const minimum = range.slice(1);
    const parsed = parseVersion(minimum);
    const maximum = parsed.major > 0
      ? `${parsed.major + 1}.0.0`
      : parsed.minor > 0
        ? `0.${parsed.minor + 1}.0`
        : `0.0.${parsed.patch + 1}`;
    return compareVersions(version, minimum) >= 0 && compareVersions(version, maximum) < 0;
  }
  if (range.startsWith("~")) {
    const minimum = range.slice(1);
    const parsed = parseVersion(minimum);
    const maximum = `${parsed.major}.${parsed.minor + 1}.0`;
    return compareVersions(version, minimum) >= 0 && compareVersions(version, maximum) < 0;
  }
  return compareVersions(version, range) === 0;
};

const internalDependencies = (manifest: PackageManifest | RegistryVersion): DependencyMap =>
  Object.fromEntries(
    Object.entries({
      ...manifest.dependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies
    }).filter(([name]) => name.startsWith(internalPrefix))
  );

const normalizeRange = (range: string) => {
  if (!range.startsWith("workspace:")) {
    return range;
  }
  return range.slice("workspace:".length) || "*";
};

const highestStableVersion = (versions: string[]) =>
  versions
    .filter((version) => !version.includes("-"))
    .sort(compareVersions)
    .at(-1);

const sameDependencies = (left: DependencyMap, right: DependencyMap) => {
  const names = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return names.every((name) => left[name] === right[name]);
};

export const auditRelease = (
  branch: string,
  packages: PackageManifest[],
  registryByName: Record<string, RegistryDocument>,
  mode: "prepublish" | "postpublish" = "prepublish"
): ReleaseAudit => {
  const errors: string[] = [];
  const pending: string[] = [];
  const warnings: string[] = [];
  const packageByName = new Map(packages.map((manifest) => [manifest.name, manifest]));

  if (branch !== "main") {
    errors.push(`Releases must run from main; current branch is ${branch}.`);
  }

  for (const manifest of packages) {
    const registry = registryByName[manifest.name] ?? {};
    const registryVersions = Object.keys(registry.versions ?? {});
    const localIsPublished = registryVersions.includes(manifest.version);
    const highestStable = highestStableVersion(registryVersions);
    const latest = registry["dist-tags"]?.latest;

    if (!localIsPublished) {
      pending.push(`${manifest.name}@${manifest.version}`);
    }

    if (highestStable && compareVersions(manifest.version, highestStable) < 0) {
      errors.push(
        `${manifest.name}: local ${manifest.version} is behind the highest published stable version ${highestStable}.`
      );
    }

    if (latest && highestStable && latest !== highestStable) {
      const pendingHigherVersion =
        !localIsPublished && compareVersions(manifest.version, highestStable) > 0;
      if (mode === "prepublish" && pendingHigherVersion) {
        warnings.push(
          `${manifest.name}: latest is ${latest}, highest published is ${highestStable}; publishing ${manifest.version} will repair the tag.`
        );
      } else {
        errors.push(
          `${manifest.name}: latest points to ${latest}, but the highest published stable version is ${highestStable}.`
        );
      }
    }

    if (mode === "postpublish" && !localIsPublished) {
      errors.push(`${manifest.name}@${manifest.version} is still missing from npm after publish.`);
    }

    const publishedManifest = registry.versions?.[manifest.version];
    if (
      publishedManifest &&
      !sameDependencies(internalDependencies(manifest), internalDependencies(publishedManifest))
    ) {
      errors.push(
        `${manifest.name}@${manifest.version}: local internal dependency metadata differs from the immutable npm version; bump the package version.`
      );
    }

    for (const [dependencyName, rawRange] of Object.entries(internalDependencies(manifest))) {
      const dependency = packageByName.get(dependencyName);
      const range = normalizeRange(rawRange);
      if (!dependency) {
        errors.push(`${manifest.name}: internal dependency ${dependencyName} is not a workspace package.`);
        continue;
      }
      if (!satisfiesVersion(dependency.version, range)) {
        errors.push(
          `${manifest.name}: ${dependencyName} ${range} does not accept the local release version ${dependency.version}.`
        );
      }
    }

    if (!latest) {
      continue;
    }
    const latestManifest = registry.versions?.[latest];
    for (const [dependencyName, rawRange] of Object.entries(internalDependencies(latestManifest ?? {}))) {
      const range = normalizeRange(rawRange);
      const dependencyVersions = Object.keys(registryByName[dependencyName]?.versions ?? {});
      if (!dependencyVersions.some((version) => satisfiesVersion(version, range))) {
        errors.push(
          `${manifest.name}@latest (${latest}) requires ${dependencyName} ${range}, but npm has no matching version.`
        );
      }
    }
  }

  return { errors, pending: pending.sort(), warnings };
};

const loadWorkspacePackages = async (): Promise<PackageManifest[]> => {
  const packages: PackageManifest[] = [];
  for await (const packageJson of new Bun.Glob("packages/*/package.json").scan(".")) {
    packages.push(await Bun.file(packageJson).json());
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
};

const loadRegistryDocument = async (name: string): Promise<RegistryDocument> => {
  const registry = (process.env.NPM_CONFIG_REGISTRY ?? "https://registry.npmjs.org").replace(/\/$/, "");
  const response = await fetch(`${registry}/${encodeURIComponent(name)}?cacheBust=${Date.now()}`, {
    cache: "no-store",
    headers: { accept: "application/vnd.npm.install-v1+json" }
  });
  if (response.status === 404) {
    return {};
  }
  if (!response.ok) {
    throw new Error(`${name}: registry request failed with HTTP ${response.status}.`);
  }
  return response.json() as Promise<RegistryDocument>;
};

const run = async () => {
  const mode = process.argv.includes("--postpublish") ? "postpublish" : "prepublish";
  const branch = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
  const packages = await loadWorkspacePackages();
  const registryEntries = await Promise.all(
    packages.map(async (manifest) => [manifest.name, await loadRegistryDocument(manifest.name)] as const)
  );
  const audit = auditRelease(branch, packages, Object.fromEntries(registryEntries), mode);

  for (const warning of audit.warnings) {
    console.warn(`warning: ${warning}`);
  }
  if (audit.pending.length > 0) {
    console.log(`${mode === "postpublish" ? "Still pending" : "Release batch"}:`);
    for (const packageVersion of audit.pending) {
      console.log(`- ${packageVersion}`);
    }
  } else {
    console.log("All local package versions are present in npm.");
  }
  if (audit.errors.length > 0) {
    for (const error of audit.errors) {
      console.error(`error: ${error}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`Release ${mode} check passed on ${branch}.`);
};

if (import.meta.main) {
  await run();
}
