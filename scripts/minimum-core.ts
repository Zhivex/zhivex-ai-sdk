import { compareVersions } from "./check-release-readiness";

export type PackageManifest = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

export type CoreMinimum = {
  package: string;
  core: string;
  range: string;
};

const corePackage = "@zhivex-ai/core";
const rangePattern = /^(?:\^|~)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** Lower bound of a caret or tilde range. Other range syntax is rejected. */
export const minimumFromRange = (range: string): string => {
  const match = rangePattern.exec(range.trim());
  const minimum = match?.[1];
  if (!minimum) {
    throw new Error(`Unsupported @zhivex-ai/core range "${range}". Expected a ^ or ~ range.`);
  }
  return minimum;
};

const declaredRange = (manifest: PackageManifest): { range: string; core: string } | undefined => {
  const ranges = [manifest.dependencies?.[corePackage], manifest.peerDependencies?.[corePackage]]
    .filter((range): range is string => typeof range === "string");
  if (!ranges.length) return undefined;
  const parsed = ranges.map(range => ({ range, core: minimumFromRange(range) }));
  parsed.sort((left, right) => compareVersions(right.core, left.core));
  return parsed[0];
};

/**
 * One row per workspace package that declares `@zhivex-ai/core`.
 * When both a dependency and a peer declare it, the higher floor wins:
 * that is the oldest version that can satisfy every declaration.
 */
export const coreMinimums = (
  manifests: ReadonlyArray<{ package: string; manifest: PackageManifest }>
): CoreMinimum[] => manifests.flatMap(({ package: packageName, manifest }) => {
  if (manifest.name === corePackage) return [];
  const declared = declaredRange(manifest);
  return declared ? [{ package: packageName, core: declared.core, range: declared.range }] : [];
}).sort((left, right) => left.package.localeCompare(right.package) || compareVersions(left.core, right.core));

export const workspaceCoreVersion = (manifest: PackageManifest): string => {
  if (!manifest.version) throw new Error("@zhivex-ai/core is missing a version.");
  return manifest.version;
};
