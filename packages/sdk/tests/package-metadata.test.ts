import { readFile } from "node:fs/promises";
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
});
