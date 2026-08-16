import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const postgresUrl = process.env.ZHIVEX_POSTGRES_INTEGRATION_URL;
if (!postgresUrl) {
  throw new Error("ZHIVEX_POSTGRES_INTEGRATION_URL is required for the installed workflow package smoke.");
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = resolve(scriptDirectory, "..");
const packageDirectories = ["core", "sdk"] as const;
const temporaryDirectory = mkdtempSync(join(tmpdir(), "zhivex-workflow-package-postgres-"));
const packDirectory = join(temporaryDirectory, "packs");
const consumerDirectory = join(temporaryDirectory, "consumer");
mkdirSync(packDirectory);
mkdirSync(consumerDirectory);

const commandEnvironment = {
  ...process.env,
  BUN_INSTALL_CACHE_DIR: join(temporaryDirectory, "bun-cache")
};

try {
  const tarballs = Object.fromEntries(
    packageDirectories.map((packageDirectory) => {
      const tarball = join(packDirectory, `${packageDirectory}.tgz`);
      execFileSync("bun", ["pm", "pack", "--quiet", "--filename", tarball], {
        cwd: join(workspaceDirectory, "packages", packageDirectory),
        env: commandEnvironment,
        stdio: "inherit"
      });
      if (!existsSync(tarball)) {
        throw new Error(`bun pm pack did not create ${tarball}.`);
      }
      return [packageDirectory, tarball];
    })
  ) as Record<(typeof packageDirectories)[number], string>;

  writeFileSync(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify({
      name: "zhivex-installed-workflow-postgres-smoke",
      private: true,
      type: "module",
      dependencies: {
        "@zhivex-ai/core": `file:${tarballs.core}`,
        "@zhivex-ai/sdk": `file:${tarballs.sdk}`,
        postgres: "^3.4.9",
        zod: "^4.4.3"
      },
      overrides: {
        "@zhivex-ai/core": `file:${tarballs.core}`
      }
    }, null, 2)}\n`
  );

  execFileSync("bun", ["install", "--ignore-scripts"], {
    cwd: consumerDirectory,
    env: commandEnvironment,
    stdio: "inherit"
  });

  const smokePath = join(consumerDirectory, "workflow-postgres-smoke.mjs");
  copyFileSync(join(scriptDirectory, "workflow-installed-postgres-smoke.mjs"), smokePath);
  execFileSync("bun", ["run", smokePath], {
    cwd: consumerDirectory,
    env: commandEnvironment,
    stdio: "inherit"
  });
} catch (error) {
  console.error(`Installed workflow Postgres smoke failed in ${temporaryDirectory}.`);
  throw error;
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
