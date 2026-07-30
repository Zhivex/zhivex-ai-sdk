import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const ignoredDirectories = new Set([".git", "dist", "node_modules"]);
const errors: string[] = [];

const reportError = (message: string) => {
  errors.push(message);
};

const toRepoPath = (filePath: string) => path.relative(repoRoot, filePath) || ".";

const listMarkdownFiles = async (directory: string): Promise<string[]> => {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }

    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(entryPath)));
    } else if (entry.name.endsWith(".md")) {
      files.push(entryPath);
    }
  }

  return files;
};

const lineNumberAt = (content: string, index: number) => content.slice(0, index).split("\n").length;

const stripDestinationTitle = (destination: string) => {
  const trimmed = destination.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1);
  }

  const titleStart = trimmed.search(/\s+["'(]/);
  return titleStart === -1 ? trimmed : trimmed.slice(0, titleStart);
};

const slugifyHeading = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");

const headingAnchors = (content: string) => {
  const anchors = new Set<string>();
  const occurrences = new Map<string, number>();
  let inFence = false;

  for (const line of content.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }

    const match = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!match) {
      continue;
    }

    const base = slugifyHeading(match[1]);
    const count = occurrences.get(base) ?? 0;
    occurrences.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }

  return anchors;
};

const markdownFiles = await listMarkdownFiles(repoRoot);
const markdownByPath = new Map<string, string>();
const anchorsByPath = new Map<string, Set<string>>();

for (const filePath of markdownFiles) {
  const content = await readFile(filePath, "utf8");
  markdownByPath.set(filePath, content);
  anchorsByPath.set(filePath, headingAnchors(content));
}

for (const [filePath, content] of markdownByPath) {
  for (const match of content.matchAll(/!?\[[^\]]*]\(([^)]+)\)/g)) {
    const destination = stripDestinationTitle(match[1]);
    if (!destination || /^(https?:|mailto:)/.test(destination)) {
      continue;
    }

    const [rawTarget, rawAnchor] = destination.split("#", 2);
    let decodedTarget: string;
    try {
      decodedTarget = decodeURIComponent(rawTarget || "");
    } catch {
      reportError(`${toRepoPath(filePath)}:${lineNumberAt(content, match.index ?? 0)}: invalid URL encoding`);
      continue;
    }
    const targetPath = decodedTarget ? path.resolve(path.dirname(filePath), decodedTarget) : filePath;
    const location = `${toRepoPath(filePath)}:${lineNumberAt(content, match.index ?? 0)}`;

    try {
      const targetStats = await stat(targetPath);
      if (rawAnchor && targetStats.isFile() && targetPath.endsWith(".md")) {
        let anchor: string;
        try {
          anchor = decodeURIComponent(rawAnchor).toLowerCase();
        } catch {
          reportError(`${location}: invalid URL encoding in anchor "${rawAnchor}"`);
          continue;
        }
        const targetAnchors =
          anchorsByPath.get(targetPath) ?? headingAnchors(await readFile(targetPath, "utf8"));
        if (!targetAnchors.has(anchor)) {
          reportError(`${location}: missing Markdown anchor "${rawAnchor}" in ${toRepoPath(targetPath)}`);
        }
      }
    } catch {
      reportError(`${location}: missing local documentation target "${destination}"`);
    }
  }
}

const getSection = (content: string, heading: string) => {
  const startPattern = new RegExp(`^## ${heading}\\s*$`, "m");
  const startMatch = startPattern.exec(content);
  if (!startMatch) {
    reportError(`Missing section "## ${heading}".`);
    return "";
  }

  const start = startMatch.index + startMatch[0].length;
  const remainder = content.slice(start);
  const nextHeading = /^##\s+/m.exec(remainder);
  return nextHeading ? remainder.slice(0, nextHeading.index) : remainder;
};

const extractPackageNames = (content: string) =>
  new Set(Array.from(content.matchAll(/`(@zhivex-ai\/[a-z0-9-]+)`/g), (match) => match[1]));

const compareInventory = (label: string, actual: Set<string>, documented: Set<string>) => {
  const missing = [...actual].filter((name) => !documented.has(name));
  const extra = [...documented].filter((name) => !actual.has(name));

  if (missing.length) {
    reportError(`${label}: missing packages: ${missing.join(", ")}`);
  }
  if (extra.length) {
    reportError(`${label}: unknown packages: ${extra.join(", ")}`);
  }
};

const packagesRoot = path.join(repoRoot, "packages");
const packageEntries = (await readdir(packagesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .sort((left, right) => left.name.localeCompare(right.name));
const publishedPackages = new Map<string, string>();

for (const entry of packageEntries) {
  const manifestPath = path.join(packagesRoot, entry.name, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { name?: string; private?: boolean };
  if (manifest.private !== true && manifest.name) {
    publishedPackages.set(entry.name, manifest.name);
  }
}

const publishedNames = new Set(publishedPackages.values());
const rootReadme = markdownByPath.get(path.join(repoRoot, "README.md")) ?? "";
const supportDoc = markdownByPath.get(path.join(repoRoot, "SUPPORT.md")) ?? "";
const stabilityDoc = markdownByPath.get(path.join(repoRoot, "STABILITY.md")) ?? "";
const agentsDoc = markdownByPath.get(path.join(repoRoot, "AGENTS.md")) ?? "";

compareInventory(
  "README.md Supported Packages",
  publishedNames,
  extractPackageNames(getSection(rootReadme, "Supported Packages"))
);
compareInventory(
  "SUPPORT.md Published Packages",
  publishedNames,
  extractPackageNames(getSection(supportDoc, "Published Packages"))
);

const stabilityImportsEnd = stabilityDoc.indexOf("\nDeep imports");
compareInventory(
  "STABILITY.md supported imports",
  publishedNames,
  extractPackageNames(stabilityImportsEnd === -1 ? stabilityDoc : stabilityDoc.slice(0, stabilityImportsEnd))
);

const agentsInventoryStart = agentsDoc.indexOf("Packages currently publishable to npm:");
const agentsInventoryRemainder =
  agentsInventoryStart === -1 ? "" : agentsDoc.slice(agentsInventoryStart + "Packages currently publishable to npm:".length);
const agentsInventoryEnd = agentsInventoryRemainder.search(/^##\s+/m);
compareInventory(
  "AGENTS.md publishable packages",
  publishedNames,
  extractPackageNames(agentsInventoryEnd === -1 ? agentsInventoryRemainder : agentsInventoryRemainder.slice(0, agentsInventoryEnd))
);

const readmeLayout = getSection(rootReadme, "Repository Layout");
for (const packageDirectory of publishedPackages.keys()) {
  if (!new RegExp(`^\\s{2}${packageDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`, "m").test(readmeLayout)) {
    reportError(`README.md Repository Layout: missing packages/${packageDirectory}`);
  }
  if (!agentsDoc.includes(`\`packages/${packageDirectory}\``)) {
    reportError(`AGENTS.md Current Monorepo Map: missing packages/${packageDirectory}`);
  }
}

const normalizeInstalledPackage = (token: string) => {
  if (token.startsWith("@")) {
    const slash = token.indexOf("/");
    const version = token.indexOf("@", slash);
    return version === -1 ? token : token.slice(0, version);
  }

  const version = token.indexOf("@");
  return version === -1 ? token : token.slice(0, version);
};

const normalizeImportedPackage = (specifier: string) => {
  if (specifier.startsWith("@")) {
    return specifier.split("/").slice(0, 2).join("/");
  }
  return specifier.split("/")[0];
};

for (const [packageDirectory, packageName] of publishedPackages) {
  const readmePath = path.join(packagesRoot, packageDirectory, "README.md");
  const content = markdownByPath.get(readmePath);
  if (!content) {
    reportError(`Missing published package README: ${toRepoPath(readmePath)}`);
    continue;
  }

  const installMatch = content.match(/^bun add (.+)$/m);
  if (!installMatch) {
    reportError(`${toRepoPath(readmePath)}: missing a "bun add" installation command`);
    continue;
  }

  const installed = new Set(
    installMatch[1]
      .trim()
      .split(/\s+/)
      .map(normalizeInstalledPackage)
  );

  if (!installed.has(packageName)) {
    reportError(`${toRepoPath(readmePath)}: installation command does not include ${packageName}`);
  }

  const imported = new Set(
    Array.from(content.matchAll(/from\s+["']([^"']+)["']/g), (match) => normalizeImportedPackage(match[1])).filter(
      (name) => name.startsWith("@zhivex-ai/") || name === "zod"
    )
  );

  for (const importedPackage of imported) {
    if (!installed.has(importedPackage)) {
      reportError(
        `${toRepoPath(readmePath)}: examples import ${importedPackage}, but the installation command does not include it`
      );
    }
  }
}

const changesetConfig = JSON.parse(await readFile(path.join(repoRoot, ".changeset/config.json"), "utf8")) as {
  changelog?: false | string;
};
if (!changesetConfig.changelog) {
  reportError(".changeset/config.json: changelog generation must remain enabled");
}

for (const fileName of ["AGENTS.md", "VERSIONING.md"]) {
  const content = markdownByPath.get(path.join(repoRoot, fileName)) ?? "";
  if (/^(bun run release(?::next)?|bunx changeset publish\b)\s*$/m.test(content)) {
    reportError(`${fileName}: do not document direct local publishing; dispatch .github/workflows/release.yml`);
  }
}

if (errors.length) {
  console.error(`Documentation check failed with ${errors.length} error${errors.length === 1 ? "" : "s"}:`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `Documentation check passed: ${markdownFiles.length} Markdown files, ${publishedPackages.size} published packages, local links and installation examples verified.`
);
