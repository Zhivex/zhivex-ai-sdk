import { compareVersions } from "./check-release-readiness.ts";

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

export interface NextDistTagCheck {
  status: "ok" | "warn";
  messages: string[];
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

export const summarizeNextDistTagCheck = (planned: readonly NextAlignment[]): NextDistTagCheck => {
  if (planned.length === 0) {
    return {
      status: "ok",
      messages: ["npm dist-tag next is not older than latest."]
    };
  }
  return {
    status: "warn",
    messages: [
      ...planned.map((alignment) =>
        `${alignment.name}: npm dist-tag next (${alignment.from}) is older than latest (${alignment.to}). Publishing with --tag latest does not move next.`
      ),
      "Stale next dist-tags were not moved. This check does not fail the release."
    ]
  };
};

export const refuseDistTagMutation = (argv: readonly string[]) => {
  if (argv.includes("--apply") || argv.includes("--check")) {
    throw new Error(
      "This check is read-only. Trusted publishing cannot move dist-tags; publish each channel with npm publish --tag."
    );
  }
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

const run = async () => {
  refuseDistTagMutation(process.argv);
  let check: NextDistTagCheck;
  try {
    check = summarizeNextDistTagCheck(
      planNextDistTagAlignment(
        await Promise.all((await loadWorkspacePackageNames()).map((name) => loadDistTagSnapshot(name)))
      )
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `warning: could not read npm dist-tags (${message}). This check does not fail the release.`
    );
    return;
  }
  for (const message of check.messages) {
    if (check.status === "warn") {
      console.warn(`warning: ${message}`);
    } else {
      console.log(message);
    }
  }
};

if (import.meta.main) {
  await run();
}
