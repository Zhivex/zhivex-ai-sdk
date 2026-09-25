import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Exercise the actual tarballs with Bun, outside workspace aliases and symlinks.
// Run after `bun run build`. Keep the directory for inspectable evidence.
const root = resolve(import.meta.dirname, "..");
const consumer = mkdtempSync(join(tmpdir(), "zhivex-harness-sdk-smoke-"));
const dependencies: Record<string, string> = {};
for (const name of ["core", "sdk", "agents"]) {
  const directory = join(root, "packages", name);
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const tarball = join(consumer, `${name}.tgz`);
  execFileSync("bun", ["pm", "pack", "--filename", tarball, "--ignore-scripts"], {
    cwd: directory,
    stdio: "pipe"
  });
  dependencies[manifest.name] = `file:${tarball}`;
}
writeFileSync(join(consumer, "package.json"), JSON.stringify({
  name: "harness-sdk-consumer-smoke", private: true, type: "module", dependencies,
  // Unversioned workspace changes share the registry version until Changesets runs.
  // Force every facade to use the same candidate tarball, never published Core.
  overrides: { "@zhivex-ai/core": dependencies["@zhivex-ai/core"] }
}, null, 2));
execFileSync("bun", ["install", "--ignore-scripts"], { cwd: consumer, stdio: "pipe" });
const typesFixture = "harness-sdk-types.ts";
writeFileSync(join(consumer, typesFixture), readFileSync(join(root, "scripts", "fixtures", typesFixture)));
execFileSync(join(root, "node_modules", ".bin", "tsc"), [
  "--noEmit", "--skipLibCheck", "--strict", "--module", "NodeNext", "--target", "ES2022", typesFixture
], { cwd: consumer, stdio: "inherit" });
for (const fixture of ["harness-sdk-smoke.mjs", "harness-compaction-smoke.mjs"]) {
  writeFileSync(join(consumer, fixture), readFileSync(join(root, "scripts", "fixtures", fixture)));
  execFileSync("bun", ["run", fixture], { cwd: consumer, stdio: "inherit" });
}
console.log(`Harness SDK tarball smoke passed. Consumer: ${consumer}`);
