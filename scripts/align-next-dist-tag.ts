import { execFileSync } from "node:child_process";

import { compareVersions, releaseOidcErrors } from "./check-release-readiness.ts";

export interface DistTagSnapshot {
  name: string;
  latest?: string;
  next?: string;
}

export interface NextAlignment {
  name: string;
  from: string;
  to: string;
}

const packageNamePattern = /^@zhivex-ai\/[a-z0-9][a-z0-9-]*$/;

export const planNextDistTagAlignment = (snapshots: readonly DistTagSnapshot[]): NextAlignment[] => {
  const planned: NextAlignment[] = [];
  for (const snapshot of snapshots) {
    if (!packageNamePattern.test(snapshot.name)) {
      throw new Error(`Refusing unexpected package name: ${snapshot.name}`);
    }
    if (!snapshot.latest || !snapshot.next) {
      continue;
    }
    if (compareVersions(snapshot.next, snapshot.latest) < 0) {
      planned.push({ name: snapshot.name, from: snapshot.next, to: snapshot.latest });
    }
  }
  return planned.sort((left, right) => left.name.localeCompare(right.name));
};

const loadWorkspacePackageNames = async (): Promise<string[]> => {
  const names: string[] = [];
  for await (const packageJson of new Bun.Glob("packages/*/package.json").scan(".")) {
    const manifest = await Bun.file(packageJson).json() as { name?: string };
    if (manifest.name?.startsWith("@zhivex-ai/")) {
      names.push(manifest.name);
    }
  }
  return names.sort();
};

const loadDistTagSnapshot = async (name: string): Promise<DistTagSnapshot> => {
  const registry = (process.env.NPM_CONFIG_REGISTRY ?? "https://registry.npmjs.org").replace(/\/$/, "");
  const response = await fetch(`${registry}/${encodeURIComponent(name)}`, {
    cache: "no-store",
    headers: { accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(`${name}: registry request failed with HTTP ${response.status}.`);
  }
  const document = await response.json() as { "dist-tags"?: { latest?: string; next?: string } };
  return {
    name,
    latest: document["dist-tags"]?.latest,
    next: document["dist-tags"]?.next
  };
};

const applyAlignment = (alignment: NextAlignment) => {
  execFileSync("npm", ["dist-tag", "add", `${alignment.name}@${alignment.to}`, "next"], {
    stdio: "inherit"
  });
};

const run = async () => {
  const apply = process.argv.includes("--apply");
  const check = process.argv.includes("--check");
  if (apply && check) {
    throw new Error("Use either --apply or --check.");
  }
  if (apply) {
    const oidcErrors = releaseOidcErrors(process.env);
    if (oidcErrors.length > 0) {
      throw new Error(oidcErrors.join("\n"));
    }
  }

  const planned = planNextDistTagAlignment(
    await Promise.all((await loadWorkspacePackageNames()).map((name) => loadDistTagSnapshot(name)))
  );
  if (planned.length === 0) {
    console.log("npm dist-tag next is not older than latest.");
    return;
  }
  for (const alignment of planned) {
    console.log(`${alignment.name}: next ${alignment.from} -> ${alignment.to}`);
  }
  if (check) {
    throw new Error(`${planned.length} npm dist-tag next value(s) are older than latest.`);
  }
  if (!apply) {
    console.log("Dry run only. Re-run with --apply from the release workflow to move these tags.");
    return;
  }
  for (const alignment of planned) {
    applyAlignment(alignment);
  }
  console.log(`Moved ${planned.length} stale next dist-tag(s) onto latest.`);
};

if (import.meta.main) {
  await run();
}
