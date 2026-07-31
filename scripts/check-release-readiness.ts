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
  gitHead?: string;
  dist?: {
    integrity?: string;
    attestations?: {
      url?: string;
      provenance?: {
        predicateType?: string;
      };
    };
  };
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

export type ReleaseDistTag = "latest" | "next";
export type ReleaseMode = "prepublish" | "postpublish";

export interface VerifyReleaseOptions {
  branch: string;
  packages: PackageManifest[];
  mode: ReleaseMode;
  distTag: ReleaseDistTag;
  loadRegistry: () => Promise<Record<string, RegistryDocument>>;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  onRetry?: (message: string) => void;
  expectedGitHead?: string;
}

const internalPrefix = "@zhivex-ai/";
const postpublishRegistryAttempts = 12;
const postpublishRegistryRetryDelayMs = 5_000;

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

const hasSha512Integrity = (value: string | undefined) =>
  typeof value === "string" &&
  /^sha512-[A-Za-z0-9+/]{86}==$/.test(value);

const hasTrustedNpmAttestationUrl = (value: string | undefined) => {
  if (!value) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.origin === "https://registry.npmjs.org" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/-\/npm\/v1\/attestations\/[^/]+\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
};

export const auditRelease = (
  branch: string,
  packages: PackageManifest[],
  registryByName: Record<string, RegistryDocument>,
  mode: ReleaseMode = "prepublish",
  distTag: ReleaseDistTag = "latest",
  expectedGitHead?: string
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
      const prereleaseChannel = parseVersion(manifest.version).prerelease?.split(".")[0];
      if (prereleaseChannel && distTag === "latest") {
        errors.push(
          `${manifest.name}@${manifest.version}: prerelease versions must use an explicit non-latest dist-tag.`
        );
      } else if (prereleaseChannel && prereleaseChannel !== distTag) {
        errors.push(
          `${manifest.name}@${manifest.version}: prerelease channel ${prereleaseChannel} does not match dist-tag ${distTag}.`
        );
      } else if (!prereleaseChannel && distTag !== "latest") {
        errors.push(`${manifest.name}@${manifest.version}: stable versions must publish to the latest dist-tag.`);
      }
    }

    if (highestStable && compareVersions(manifest.version, highestStable) < 0) {
      errors.push(
        `${manifest.name}: local ${manifest.version} is behind the highest published stable version ${highestStable}.`
      );
    }

    if (mode === "prepublish" && latest && highestStable && latest !== highestStable) {
      const pendingHigherVersion =
        !localIsPublished && compareVersions(manifest.version, highestStable) > 0;
      if (pendingHigherVersion) {
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

    if (
      mode === "postpublish" &&
      localIsPublished &&
      registry["dist-tags"]?.[distTag] !== manifest.version
    ) {
      errors.push(
        `${manifest.name}@${manifest.version}: npm dist-tag ${distTag} points to ${registry["dist-tags"]?.[distTag] ?? "nothing"}.`
      );
    }

    const publishedManifest = registry.versions?.[manifest.version];
    if (mode === "postpublish" && publishedManifest) {
      if (!hasSha512Integrity(publishedManifest.dist?.integrity)) {
        errors.push(
          `${manifest.name}@${manifest.version}: npm metadata is missing a sha512 integrity digest.`
        );
      }
      const provenance = publishedManifest.dist?.attestations?.provenance?.predicateType;
      const attestationUrl = publishedManifest.dist?.attestations?.url;
      if (
        provenance !== "https://slsa.dev/provenance/v1" ||
        !hasTrustedNpmAttestationUrl(attestationUrl)
      ) {
        errors.push(
          `${manifest.name}@${manifest.version}: npm metadata is missing a trusted publishing provenance attestation.`
        );
      }
      if (expectedGitHead && publishedManifest.gitHead !== expectedGitHead) {
        errors.push(
          `${manifest.name}@${manifest.version}: npm gitHead ${publishedManifest.gitHead ?? "is missing"}; expected ${expectedGitHead}.`
        );
      }
    }
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

const retryablePostpublishAudit = (audit: ReleaseAudit) =>
  audit.pending.length > 0 ||
  audit.errors.some((error) =>
    error.includes("npm dist-tag") ||
    error.includes("npm metadata") ||
    error.includes("npm gitHead")
  );

const wait = (delayMs: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });

export const verifyReleaseWithRetry = async ({
  branch,
  packages,
  mode,
  distTag,
  loadRegistry,
  maxAttempts = postpublishRegistryAttempts,
  retryDelayMs = postpublishRegistryRetryDelayMs,
  sleep = wait,
  onRetry,
  expectedGitHead
}: VerifyReleaseOptions): Promise<ReleaseAudit> => {
  const attempts = mode === "postpublish" ? Math.max(1, maxAttempts) : 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const audit = auditRelease(
        branch,
        packages,
        await loadRegistry(),
        mode,
        distTag,
        expectedGitHead
      );
      if (mode !== "postpublish" || !retryablePostpublishAudit(audit) || attempt === attempts) {
        return audit;
      }
      onRetry?.(
        `npm registry propagation is incomplete; retrying postpublish verification ${attempt + 1}/${attempts} in ${retryDelayMs}ms.`
      );
    } catch (error) {
      if (mode !== "postpublish" || attempt === attempts) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      onRetry?.(
        `npm registry request failed (${message}); retrying postpublish verification ${attempt + 1}/${attempts} in ${retryDelayMs}ms.`
      );
    }

    await sleep(retryDelayMs);
  }

  throw new Error("Postpublish verification exhausted all retry attempts.");
};

export const releaseWorktreeErrors = (status: string): string[] =>
  status.trim()
    ? ["Release source must be committed: the worktree contains tracked or untracked changes."]
    : [];

export const releaseOidcErrors = (environment: Record<string, string | undefined>): string[] =>
  environment.GITHUB_ACTIONS === "true" &&
  Boolean(environment.ACTIONS_ID_TOKEN_REQUEST_URL) &&
  Boolean(environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
    ? []
    : ["Publishing requires GitHub Actions trusted publishing with an available OIDC identity token."];

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
    // The abbreviated install document intentionally omits gitHead. The full
    // packument is required to bind the published artifact to this commit.
    headers: { accept: "application/json" }
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
  const distTagArgument = process.argv.find((argument) => argument.startsWith("--tag="));
  const distTag = (distTagArgument?.slice("--tag=".length) ?? "latest") as ReleaseDistTag;
  if (distTag !== "latest" && distTag !== "next") {
    throw new Error(`Unsupported release dist-tag: ${distTag}.`);
  }
  const branch = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
  const worktreeStatus = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { encoding: "utf8" }
  );
  const packages = await loadWorkspacePackages();
  const expectedGitHead = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8"
  }).trim();
  const audit = await verifyReleaseWithRetry({
    branch,
    packages,
    mode,
    distTag,
    expectedGitHead: mode === "postpublish" ? expectedGitHead : undefined,
    loadRegistry: async () => {
      const registryEntries = await Promise.all(
        packages.map(async (manifest) => [manifest.name, await loadRegistryDocument(manifest.name)] as const)
      );
      return Object.fromEntries(registryEntries);
    },
    onRetry: (message) => console.warn(`warning: ${message}`)
  });
  audit.errors.unshift(...releaseWorktreeErrors(worktreeStatus));
  if (process.argv.includes("--require-oidc")) {
    audit.errors.unshift(...releaseOidcErrors(process.env));
  }

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
