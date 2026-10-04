import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const versions = { npm: "10.9.4", pnpm: "10.34.6", yarn: "1.22.22", bun: "1.3.7" };
const manager = process.argv[2];
assert.ok(Object.hasOwn(versions, manager), "Usage: node scripts/package-manager-consumer-smoke.mjs <npm|pnpm|yarn|bun>");
const temporary = mkdtempSync(join(tmpdir(), `zhivex-${manager}-consumer-`));
const packs = join(temporary, "packs");
const consumer = join(temporary, "consumer");
mkdirSync(packs);
mkdirSync(consumer);
const env = {
  ...process.env,
  // This fixture is always offline even when the caller has live-test settings.
  ZHIVEX_GOLDEN_PATH_LIVE: "0",
  NODE_PATH: "",
  NODE_OPTIONS: "",
  NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
  NPM_CONFIG_USERCONFIG: join(temporary, "npmrc"),
  NPM_CONFIG_CACHE: join(temporary, "npm-cache"),
  NPM_CONFIG_AUDIT: "false",
  NPM_CONFIG_FUND: "false",
  NPM_CONFIG_UPDATE_NOTIFIER: "false",
  YARN_CACHE_FOLDER: join(temporary, "yarn-cache"),
  BUN_INSTALL_CACHE_DIR: join(temporary, "bun-cache")
};
writeFileSync(env.NPM_CONFIG_USERCONFIG, "registry=https://registry.npmjs.org\n");
const run = (command, args, cwd = consumer, capture = false) => execFileSync(command, args, {
  cwd, env, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit"
});

try {
  const managerVersion = run(manager, ["--version"], consumer, true).trim();
  assert.equal(managerVersion, versions[manager], `Use pinned ${manager}@${versions[manager]}`);
  assert.equal(run("npm", ["--version"], consumer, true).trim(), versions.npm, "Packing requires npm@10.9.4");
  const packed = readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = join(root, "packages", entry.name);
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      const [result] = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", packs, directory], temporary, true));
      assert.ok(result?.filename, `Missing tarball for ${manifest.name}`);
      const tarball = join(packs, result.filename);
      const files = Object.fromEntries(result.files.map(({ path }) => [path,
        createHash("sha256").update(readFileSync(join(directory, path))).digest("hex")
      ]));
      return { manifest, tarball, files, integrity: createHash("sha256").update(readFileSync(tarball)).digest("hex") };
    });
  // Retain published dependency ranges. No overrides, resolutions, workspace
  // aliases or rewritten package manifests are used.
  const dependencies = Object.fromEntries(packed.map(({ manifest, tarball }) => [manifest.name, `file:${tarball}`]));
  Object.assign(dependencies, {
    "react": "19.3.0", "react-dom": "19.3.0",
    "react-markdown": "10.1.0", "remark-gfm": "4.0.1",
    "@tanstack/react-virtual": "3.14.13",
    "typescript": "5.9.3", "@types/node": "22.19.0"
  });
  writeFileSync(join(consumer, "package.json"), JSON.stringify({
    name: "zhivex-manager-consumer", private: true, type: "module",
    packageManager: `${manager}@${managerVersion}`, dependencies
  }, null, 2));
  if (manager === "yarn") writeFileSync(join(consumer, ".yarnrc"), 'registry "https://registry.npmjs.org"\n');
  const installArgs = {
    npm: ["install", "--ignore-scripts", "--strict-peer-deps"],
    pnpm: ["install", "--ignore-scripts", "--strict-peer-dependencies", "--store-dir", join(temporary, "pnpm-store")],
    yarn: ["install", "--ignore-scripts", "--non-interactive"],
    bun: ["install", "--ignore-scripts"]
  };
  run(manager, installArgs[manager]);
  const runtime = manager === "bun" ? "bun" : "node";
  const specifiers = packed.flatMap(({ manifest }) => Object.entries(manifest.exports).filter(([, target]) =>
    typeof target === "string" ? target.endsWith(".js") : target.import || target.default
  ).map(([subpath]) => subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`));
  writeFileSync(join(consumer, "exports.mjs"), `
import assert from "node:assert/strict";
import { realpathSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const consumer = dirname(fileURLToPath(import.meta.url));
const packed = ${JSON.stringify(packed.map(({ manifest, files }) => ({ name: manifest.name, version: manifest.version, dependencies: manifest.dependencies ?? {}, files })))};
const internalDependencies = [];
const verifyFiles = (entry, pkg) => {
  const directory = join(dirname(entry), "..");
  assert.ok(relative(consumer, realpathSync(directory)).startsWith("node_modules/"), pkg.name + " escaped the consumer");
  for (const [file, hash] of Object.entries(pkg.files)) {
    assert.equal(createHash("sha256").update(readFileSync(join(directory, file))).digest("hex"), hash, pkg.name + "/" + file + " differs from the packed artifact");
  }
};
for (const pkg of packed) {
  const entry = realpathSync(fileURLToPath(import.meta.resolve(pkg.name)));
  assert.ok(relative(consumer, entry).startsWith("node_modules/"), pkg.name + " escaped the clean consumer");
  const installed = JSON.parse(readFileSync(join(dirname(entry), "../package.json"), "utf8"));
  assert.equal(installed.name, pkg.name);
  assert.equal(installed.version, pkg.version);
  verifyFiles(entry, pkg);
  for (const dependency of Object.keys(pkg.dependencies).filter((name) => name.startsWith("@zhivex-ai/"))) {
    const dependencyEntry = realpathSync(fileURLToPath(import.meta.resolve(dependency, pathToFileURL(entry).href)));
    assert.ok(relative(consumer, dependencyEntry).startsWith("node_modules/"), dependency + " escaped the consumer");
    const installedDependency = JSON.parse(readFileSync(join(dirname(dependencyEntry), "../package.json"), "utf8"));
    internalDependencies.push({ package: pkg.name, dependency, range: pkg.dependencies[dependency], version: installedDependency.version, source: dependencyEntry === realpathSync(fileURLToPath(import.meta.resolve(dependency))) ? "packed" : "registry" });
  }
}
for (const specifier of ${JSON.stringify(specifiers)}) {
  const exports = await import(specifier);
  assert.ok(Object.keys(exports).length || specifier === "@zhivex-ai/core/contracts", specifier);
}
const sdk = await import("@zhivex-ai/sdk");
const core = await import("@zhivex-ai/core");
assert.equal(typeof sdk.Agent, "function");
assert.equal(typeof core.generateText, "function");
assert.deepEqual(core.createTextMessage("user", "packed-core"), { role: "user", parts: [{ type: "text", text: "packed-core" }] });
console.log("MANAGER_EXPORTS_OK ${specifiers.length}");
console.log(JSON.stringify({ type: "installed_internal_dependencies", dependencies: internalDependencies }));
`);
  run(runtime, [...(runtime === "node" ? ["--experimental-import-meta-resolve"] : []), join(consumer, "exports.mjs")]);
  // Invoke the installed CLI through each manager's bin resolution.
  const cliArgs = manager === "yarn" ? ["--silent", "exec", "zhivex-ai", "--", "--version"] : ["exec", "--", "zhivex-ai", "--version"];
  // Bun's `run` resolves local bins without downloading a fallback package.
  if (manager === "bun") cliArgs.splice(0, cliArgs.length, "run", "zhivex-ai", "--version");
  const cli = JSON.parse(run(manager, cliArgs, consumer, true));
  assert.equal(cli.version, packed.find(({ manifest }) => manifest.name === "@zhivex-ai/sdk").manifest.version);
  assert.equal(cli.type, "cli_version");
  const golden = readFileSync(join(root, "scripts/fixtures/golden-path-installed-smoke.mjs"), "utf8");
  writeFileSync(join(consumer, "golden.mjs"), golden);
  run(runtime, [join(consumer, "golden.mjs")]);
  writeFileSync(join(consumer, "types.ts"), `
import { Agent, createTextMessage, generateText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";
import type { LanguageModel } from "@zhivex-ai/core";
const model: LanguageModel = createOpenAI({ apiKey: "offline-types-only" })("gpt-6-astra");
new Agent({ model });
void generateText({ model, messages: [createTextMessage("user", "types only")] });
`);
  run("node", [join(consumer, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--module", "NodeNext", "--target", "ES2022", "types.ts"]);
  console.log(JSON.stringify({
    status: "passed", manager, managerVersion,
    sourceGitSha: process.env.GITHUB_SHA ?? run("git", ["rev-parse", "HEAD"], root, true).trim(),
    runtime, runtimeVersion: run(runtime, ["--version"], consumer, true).trim(),
    packing: `npm@${versions.npm}`, entrypoints: specifiers.length,
    packages: packed.map(({ manifest, integrity }) => ({ name: manifest.name, version: manifest.version, sha256: integrity }))
  }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
