import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Build first. Pack and install actual artifacts, including zod, without registry or model requests.
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "zhivex-unknown-tool-"));
try {
  const dependencies: Record<string, string> = {};
  for (const relative of ["packages/core", "packages/agents", "packages/sdk", "node_modules/zod"]) {
    const cwd = resolve(root, relative);
    const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    const filename = join(directory, `${manifest.name.replace(/[@/]/g, "-")}.tgz`);
    execFileSync("bun", ["pm", "pack", "--ignore-scripts", "--quiet", "--filename", filename], { cwd, stdio: "pipe" });
    dependencies[manifest.name] = `file:${filename}`;
  }
  writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true, type: "module", dependencies, overrides: dependencies }));
  execFileSync("bun", ["install", "--ignore-scripts"], { cwd: directory, stdio: "pipe", env: { ...process.env, TMPDIR: directory, BUN_INSTALL_CACHE_DIR: join(directory, "cache") } });
  writeFileSync(join(directory, "smoke.mjs"), readFileSync(join(root, "scripts/fixtures/unknown-tool-installed-smoke.mjs")));
  execFileSync("bun", ["--no-env-file", "smoke.mjs"], { cwd: directory, stdio: "inherit" });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
