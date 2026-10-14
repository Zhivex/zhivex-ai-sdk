import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const releaseBatchEntryPattern =
  /^(@zhivex-ai\/[a-z0-9][a-z0-9-]*)@([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$/;
const publicRegistry = "https://registry.npmjs.org";

export const publishedInstallAttempts = 8;
export const publishedInstallRetryDelayMs = 5_000;
export const publishedInstallMaxRetryDelayMs = 30_000;
const publishedInstallTimeoutMs = 180_000;

export const parsePublishedReleaseBatch = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("Release batch must be a JSON array of package@version strings.");
  }
  const parsed = value.map((entry) => {
    if (!releaseBatchEntryPattern.test(entry)) {
      throw new Error(`Refusing unexpected release batch entry: ${entry}`);
    }
    return entry;
  });
  return [...new Set(parsed)].sort();
};

export const publishedInstallDelayMs = (
  attempt: number,
  retryDelayMs = publishedInstallRetryDelayMs,
  maxRetryDelayMs = publishedInstallMaxRetryDelayMs
) => Math.min(retryDelayMs * (2 ** (attempt - 1)), maxRetryDelayMs);

export const dependencySpecifiers = (specifiers: readonly string[]): Record<string, string> =>
  Object.fromEntries(specifiers.map((specifier) => {
    const separator = specifier.lastIndexOf("@");
    return [specifier.slice(0, separator), specifier.slice(separator + 1)];
  }));

export const installPublishedRelease = async ({
  specifiers,
  install,
  sleep,
  maxAttempts = publishedInstallAttempts,
  retryDelayMs = publishedInstallRetryDelayMs,
  maxRetryDelayMs = publishedInstallMaxRetryDelayMs,
  onRetry
}: {
  specifiers: readonly string[];
  install: (specifiers: readonly string[]) => Promise<void> | void;
  sleep: (delayMs: number) => Promise<void>;
  maxAttempts?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  onRetry?: (message: string) => void;
}): Promise<number> => {
  if (specifiers.length === 0) {
    return 0;
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await install(specifiers);
      return attempt;
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error;
      }
      const delay = publishedInstallDelayMs(attempt, retryDelayMs, maxRetryDelayMs);
      const message = error instanceof Error ? error.message : String(error);
      onRetry?.(
        `public npm install failed (${message}); retrying ${attempt + 1}/${maxAttempts} in ${delay}ms.`
      );
      await sleep(delay);
    }
  }
  throw new Error("Public npm install exhausted all retry attempts.");
};

const installFromPublicRegistry = (specifiers: readonly string[]) => {
  const temporary = mkdtempSync(join(tmpdir(), "zhivex-published-"));
  const dependencies = dependencySpecifiers(specifiers);
  try {
    const npmrc = join(temporary, "npmrc");
    writeFileSync(npmrc, `registry=${publicRegistry}\n`);
    writeFileSync(join(temporary, "package.json"), `${JSON.stringify({
      name: "zhivex-published-consumer",
      private: true,
      dependencies
    })}\n`);
    const env = { ...process.env };
    delete env.NODE_AUTH_TOKEN;
    delete env.NPM_TOKEN;
    delete env.NPM_CONFIG__AUTH;
    execFileSync("npm", [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--prefer-online",
      `--registry=${publicRegistry}`
    ], {
      cwd: temporary,
      env: {
        ...env,
        NPM_CONFIG_REGISTRY: publicRegistry,
        NPM_CONFIG_USERCONFIG: npmrc,
        NPM_CONFIG_CACHE: join(temporary, "npm-cache")
      },
      stdio: "inherit",
      timeout: publishedInstallTimeoutMs
    });
    for (const [name, version] of Object.entries(dependencies)) {
      const manifest = JSON.parse(readFileSync(
        join(temporary, "node_modules", ...name.split("/"), "package.json"),
        "utf8"
      )) as { version?: string };
      if (manifest.version !== version) {
        throw new Error(
          `${name}@${version} resolved to ${manifest.version ?? "nothing"} from the public registry.`
        );
      }
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
};

const argument = (name: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);

const run = async () => {
  const releaseBatchFile = argument("release-batch-file");
  if (!releaseBatchFile) {
    throw new Error("Usage: install-published-release.ts --release-batch-file=<path>");
  }
  const specifiers = parsePublishedReleaseBatch(JSON.parse(readFileSync(releaseBatchFile, "utf8")));
  if (specifiers.length === 0) {
    console.log("No packages in this release batch; skipping public registry install.");
    return;
  }
  const attempt = await installPublishedRelease({
    specifiers,
    install: installFromPublicRegistry,
    sleep: (delayMs) => new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    }),
    onRetry: (message) => console.warn(`warning: ${message}`)
  });
  console.log(`Installed ${specifiers.length} published package(s) from ${publicRegistry} on attempt ${attempt}.`);
};

if (import.meta.main) {
  await run();
}
