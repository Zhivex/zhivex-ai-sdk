import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface PackageManifest {
  name: string;
  exports?: Record<string, unknown> | string;
}

interface NpmPackResult {
  filename: string;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = resolve(scriptDirectory, "..");
const packagesDirectory = join(workspaceDirectory, "packages");

const hasJavaScriptExport = (target: unknown): boolean => {
  if (typeof target === "string") {
    return !target.endsWith(".css");
  }
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return false;
  }
  const conditions = target as Record<string, unknown>;
  return "import" in conditions || "default" in conditions;
};

const importSpecifiers = (manifest: PackageManifest) => {
  if (!manifest.exports || typeof manifest.exports === "string") {
    return [manifest.name];
  }
  return Object.entries(manifest.exports)
    .filter(([, target]) => hasJavaScriptExport(target))
    .map(([subpath]) => subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`);
};

const manifests = readdirSync(packagesDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({
    directory: join(packagesDirectory, entry.name),
    manifest: JSON.parse(readFileSync(join(packagesDirectory, entry.name, "package.json"), "utf8")) as PackageManifest
  }))
  .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));

const temporaryDirectory = mkdtempSync(join(tmpdir(), "zhivex-package-smoke-"));
const packDirectory = join(temporaryDirectory, "packs");
const consumerDirectory = join(temporaryDirectory, "consumer");
const npmCacheDirectory = join(temporaryDirectory, "npm-cache");
mkdirSync(packDirectory);
mkdirSync(consumerDirectory);

const commandEnvironment = {
  ...process.env,
  NPM_CONFIG_CACHE: npmCacheDirectory,
  NPM_CONFIG_FUND: "false",
  NPM_CONFIG_AUDIT: "false",
  NPM_CONFIG_UPDATE_NOTIFIER: "false"
};

try {
  const tarballs = manifests.map(({ directory }) => {
    const output = execFileSync(
      "npm",
      ["pack", "--json", "--pack-destination", packDirectory, directory],
      {
        cwd: workspaceDirectory,
        encoding: "utf8",
        env: commandEnvironment,
        stdio: ["ignore", "pipe", "inherit"]
      }
    );
    const result = JSON.parse(output) as NpmPackResult[];
    if (result.length !== 1 || !result[0]?.filename) {
      throw new Error(`npm pack returned an unexpected result for ${directory}.`);
    }
    return join(packDirectory, result[0].filename);
  });

  writeFileSync(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify({ name: "zhivex-package-consumer-smoke", private: true, type: "module" }, null, 2)}\n`
  );
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", ...tarballs],
    { cwd: consumerDirectory, env: commandEnvironment, stdio: "inherit" }
  );

  const specifiers = manifests.flatMap(({ manifest }) => importSpecifiers(manifest));
  const smokeSource = `
import assert from "node:assert/strict";

const specifiers = ${JSON.stringify(specifiers)};
for (const specifier of specifiers) {
  const exports = await import(specifier);
  assert.ok(Object.keys(exports).length > 0, \`\${specifier} has no runtime exports\`);
}

const { createHttpTool } = await import("@zhivex-ai/core");
const originalFetch = globalThis.fetch;
try {
  for (const status of [204, 205]) {
    globalThis.fetch = async () => new Response(null, { status });
    const entry = createHttpTool({
      name: \`bodyless\${status}\`,
      schema: {},
      url: "https://example.com/tool",
      mapResponse: async (response) => ({ status: response.status, body: await response.text() })
    });
    assert.ok("execute" in entry.tool);
    assert.deepEqual(await entry.tool.execute({}), { status, body: "" });
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log(\`Node package consumer smoke: \${specifiers.length} entrypoints imported\`);
`;
  const smokePath = join(consumerDirectory, "smoke.mjs");
  writeFileSync(smokePath, smokeSource);
  execFileSync("node", [smokePath], {
    cwd: consumerDirectory,
    env: commandEnvironment,
    stdio: "inherit"
  });
} catch (error) {
  console.error(`Package consumer smoke failed in ${temporaryDirectory}.`);
  throw error;
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
