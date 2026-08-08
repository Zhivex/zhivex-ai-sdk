import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = resolve(scriptDirectory, "..");
const packageDirectories = ["core", "agents", "gemini", "deepseek", "qwen"] as const;

const postgresUrl = process.env.ZHIVEX_POSTGRES_INTEGRATION_URL;
const missingProviders = [
  ...(!(process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY) ? ["gemini"] : []),
  ...(!process.env.DEEPSEEK_API_KEY ? ["deepseek"] : []),
  ...(!(process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY) ? ["qwen"] : [])
];
if (!postgresUrl) {
  throw new Error("ZHIVEX_POSTGRES_INTEGRATION_URL is required for the installed agent live smoke.");
}
if (missingProviders.length) {
  throw new Error(`Installed agent live smoke is missing credentials for: ${missingProviders.join(", ")}.`);
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), "zhivex-agent-package-live-"));
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
      const filename = `${packageDirectory}.tgz`;
      const tarball = join(packDirectory, filename);
      execFileSync(
        "bun",
        ["pm", "pack", "--quiet", "--filename", tarball],
        {
          cwd: join(workspaceDirectory, "packages", packageDirectory),
          env: commandEnvironment,
          stdio: "inherit"
        }
      );
      if (!existsSync(tarball)) {
        throw new Error(`bun pm pack did not create ${tarball}.`);
      }
      return [packageDirectory, tarball];
    })
  ) as Record<(typeof packageDirectories)[number], string>;

  writeFileSync(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify({
      name: "zhivex-installed-agent-live-smoke",
      private: true,
      type: "module",
      dependencies: {
        "@zhivex-ai/core": `file:${tarballs.core}`,
        "@zhivex-ai/agents": `file:${tarballs.agents}`,
        "@zhivex-ai/gemini": `file:${tarballs.gemini}`,
        "@zhivex-ai/deepseek": `file:${tarballs.deepseek}`,
        "@zhivex-ai/qwen": `file:${tarballs.qwen}`,
        postgres: "^3.4.8",
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

  const smokePath = join(consumerDirectory, "agent-live-smoke.mjs");
  copyFileSync(join(scriptDirectory, "agent-installed-live-smoke.mjs"), smokePath);
  execFileSync("bun", ["run", smokePath], {
    cwd: consumerDirectory,
    env: commandEnvironment,
    stdio: "inherit"
  });
} catch (error) {
  console.error(`Installed agent package live smoke failed in ${temporaryDirectory}.`);
  throw error;
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
