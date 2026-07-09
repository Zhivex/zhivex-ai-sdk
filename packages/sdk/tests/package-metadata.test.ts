import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const readPackage = async (packageName: string) =>
  JSON.parse(await readFile(path.resolve(import.meta.dirname, `../../${packageName}/package.json`), "utf8")) as {
    name: string;
    type?: string;
    main?: string;
    types?: string;
    bin?: Record<string, string>;
    exports?: Record<string, unknown>;
    files?: string[];
    publishConfig?: { access?: string };
  };

const packagesDir = path.resolve(import.meta.dirname, "../..");

const listWorkspacePackages = async () => {
  const directories = (await readdir(packagesDir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  const packages = await Promise.all(
    directories.map(async (entry) => {
      try {
        await access(path.join(packagesDir, entry.name, "package.json"));
        return entry.name;
      } catch {
        return undefined;
      }
    })
  );
  return packages.filter((packageName): packageName is string => Boolean(packageName)).sort();
};

describe("package metadata", () => {
  it("keeps core publish metadata ready for npm packaging", async () => {
    const pkg = await readPackage("core");
    expect(pkg).toMatchObject({
      name: "@zhivex-ai/core",
      type: "module",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      publishConfig: { access: "public" }
    });
    expect(pkg.exports?.["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js"
    });
    expect(pkg.files).toContain("dist");
  });

  it("keeps sdk publish metadata and CLI bin ready for npm packaging", async () => {
    const pkg = await readPackage("sdk");
    expect(pkg).toMatchObject({
      name: "@zhivex-ai/sdk",
      type: "module",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      bin: { "zhivex-ai": "./dist/cli.js" },
      publishConfig: { access: "public" }
    });
    expect(pkg.exports?.["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js"
    });
    expect(pkg.files).toContain("dist");
  });

  it("keeps agents publish metadata ready for npm packaging", async () => {
    const pkg = await readPackage("agents");
    expect(pkg).toMatchObject({
      name: "@zhivex-ai/agents",
      type: "module",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      publishConfig: { access: "public" }
    });
    expect(pkg.exports?.["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js"
    });
    expect(pkg.files).toContain("dist");
  });

  it("keeps every workspace package publish-ready", async () => {
    const packages = await listWorkspacePackages();

    await Promise.all(
      packages.map(async (packageName) => {
        const pkg = await readPackage(packageName);
        expect(pkg.name).toBe(`@zhivex-ai/${packageName}`);
        expect(pkg).toMatchObject({
          type: "module",
          main: "./dist/index.js",
          types: "./dist/index.d.ts",
          publishConfig: { access: "public" }
        });
        expect(pkg.exports?.["."]).toEqual({
          types: "./dist/index.d.ts",
          import: "./dist/index.js"
        });
        expect(pkg.files).toContain("dist");
      })
    );
  });
});
