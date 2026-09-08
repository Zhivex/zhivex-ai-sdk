import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { syncReleaseConsumers } from "./sync-release-consumers.js";

it.each(["1.16.0", "1.16.0-next.0"])("synchronizes the versioned starter atomically and idempotently (%s)", async version => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sdk-release-consumers-"));
  try {
    await mkdir(path.join(root, "examples/next-runner"), { recursive: true });
    const starterPath = path.join(root, "examples/next-runner/package.json");
    const dependencies = { "@zhivex-ai/sdk": "1.15.0", "@zhivex-ai/openai": "0.11.1", "@zhivex-ai/react": "0.4.0", next: "16.3.2" };
    await writeFile(starterPath, JSON.stringify({ private: true, dependencies }));
    for (const [name, value] of Object.entries({ sdk: version, openai: "0.11.2", react: "0.4.0" })) {
      await mkdir(path.join(root, "packages", name), { recursive: true });
      await writeFile(path.join(root, "packages", name, "package.json"), JSON.stringify({ version: value }));
    }
    expect(await syncReleaseConsumers(root)).toBe(true);
    expect(JSON.parse(await readFile(starterPath, "utf8"))).toEqual({ private: true, dependencies: { ...dependencies, "@zhivex-ai/sdk": version, "@zhivex-ai/openai": "0.11.2" } });
    expect(await syncReleaseConsumers(root)).toBe(false);
    await writeFile(path.join(root, "packages/react/package.json"), "{}");
    const before = await readFile(starterPath, "utf8");
    await expect(syncReleaseConsumers(root)).rejects.toThrow("Missing release version");
    expect(await readFile(starterPath, "utf8")).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
