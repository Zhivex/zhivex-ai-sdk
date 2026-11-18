import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const version = "4.0.7";
const packageVersion = `picomatch@${version}`;
const patch = `patches/${packageVersion}.patch`;
const advisory = "GHSA-fc5q-39xc-vjpf";
const manifest = await Bun.file(resolve(root, "package.json")).json();
const args = ["audit"];

if (manifest.patchedDependencies?.[packageVersion] !== undefined) {
  assert.equal(manifest.patchedDependencies[packageVersion], patch);
  const lock = Bun.JSONC.parse(await Bun.file(resolve(root, "bun.lock")).text()) as {
    patchedDependencies?: Record<string, string>;
    packages: Record<string, [string, ...unknown[]]>;
  };
  assert.equal(lock.patchedDependencies?.[packageVersion], patch);
  const copies = Object.values(lock.packages).filter(([resolution]) => resolution.startsWith("picomatch@"));
  assert.deepEqual(copies.map(([resolution]) => resolution), [packageVersion]);

  const inventory = Bun.spawnSync([process.execPath, "pm", "licenses", "--prod", "--json"], {
    cwd: root,
    stderr: "inherit"
  });
  assert.equal(inventory.exitCode, 0, "Failed to read the production dependency inventory");
  const licenses = JSON.parse(inventory.stdout.toString()) as Record<string, Array<{ name: string }>>;
  const productionPackages = Object.values(licenses).flat();
  assert.ok(productionPackages.length > 0, "Production dependency inventory is empty");
  assert.ok(!productionPackages.some(({ name }) => name === "picomatch"),
    "The patched picomatch advisory exception applies only to development tooling");

  const require = createRequire(import.meta.url);
  for (const consumer of ["vitest", "@changesets/cli"]) {
    const fromConsumer = createRequire(require.resolve(`${consumer}/package.json`));
    assert.equal(fromConsumer("picomatch/package.json").version, version);
    const match = fromConsumer("picomatch");
    assert.ok(match.isMatch("packages/core/src/model.ts", "packages/**/{src,tests}/*.ts"));
    for (const pattern of ["+(sample)", "*(sample)"]) {
      assert.throws(() => match.makeRe(pattern), /Repeating extglobs are disabled by the workspace security patch/);
    }
  }

  console.log(`Verified the development-only ${packageVersion} patch for ${advisory}.`);
  args.push("--ignore", advisory);
}

const audit = Bun.spawnSync([process.execPath, ...args], { cwd: root, stdout: "inherit", stderr: "inherit" });
process.exitCode = audit.exitCode ?? 1;
