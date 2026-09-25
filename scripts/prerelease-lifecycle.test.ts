import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cli = path.resolve(import.meta.dirname, "../node_modules/@changesets/cli/bin.js");

describe("Changesets prerelease lifecycle", () => {
  it("tracks consumed changes in pre/ and advances next before graduating stable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zhivex-prerelease-lifecycle-"));
    const json = async (file: string, value: unknown) => {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), JSON.stringify(value, null, 2));
    };
    const read = async (file: string) => JSON.parse(await readFile(path.join(root, file), "utf8"));
    const run = async (...args: string[]) => {
      try { return await execFileAsync("bun", [cli, ...args], { cwd: root }); }
      catch (error) {
        const output = error as { stdout?: string; stderr?: string };
        throw new Error(`Changesets ${args.join(" ")} failed: ${output.stdout ?? ""}${output.stderr ?? ""}`);
      }
    };
    try {
      await json("package.json", { name: "prerelease-fixture", private: true, workspaces: ["packages/*"] });
      // Workspace discovery uses the Bun lockfile marker; no install is needed.
      await writeFile(path.join(root, "bun.lock"), "{}\n");
      await json("packages/core/package.json", { name: "@fixture/core", version: "1.23.0" });
      await json("packages/sdk/package.json", { name: "@fixture/sdk", version: "1.26.0", dependencies: { "@fixture/core": "~1.23.0" } });
      await json(".changeset/config.json", { changelog: false, commit: false, access: "public", baseBranch: "main", updateInternalDependencies: "patch", fixed: [], linked: [], ignore: [] });
      await run("pre", "enter", "next");
      expect(await read(".changeset/pre.json")).toEqual({ mode: "pre", tag: "next" });
      await writeFile(path.join(root, ".changeset/feature.md"), '---\n"@fixture/core": minor\n"@fixture/sdk": minor\n---\n\nFeature.\n');
      await run("version");
      expect((await read("packages/core/package.json")).version).toBe("1.24.0-next.0");
      expect((await read("packages/sdk/package.json")).version).toBe("1.27.0-next.0");
      expect(await readdir(path.join(root, ".changeset/pre"))).toContain("feature.md");
      expect(await readdir(path.join(root, ".changeset"))).not.toContain("feature.md");
      await writeFile(path.join(root, ".changeset/fix.md"), '---\n"@fixture/core": patch\n"@fixture/sdk": patch\n---\n\nPrerelease fix.\n');
      await run("version");
      expect((await read("packages/core/package.json")).version).toBe("1.24.0-next.1");
      expect((await read("packages/sdk/package.json")).version).toBe("1.27.0-next.1");
      expect(await readdir(path.join(root, ".changeset/pre"))).toEqual(expect.arrayContaining(["feature.md", "fix.md"]));
      await run("pre", "exit");
      await run("version");
      expect((await read("packages/core/package.json")).version).toBe("1.24.0");
      expect((await read("packages/sdk/package.json")).version).toBe("1.27.0");
      expect((await read("packages/sdk/package.json")).dependencies["@fixture/core"]).toBe("~1.24.0");
      expect(await readdir(path.join(root, ".changeset"))).not.toContain("pre.json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
