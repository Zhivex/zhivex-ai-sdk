import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startCandidateRegistry } from "./candidate-registry.mjs";

it("exposes only the exact unpublished batch with original ranges and integrity-checked bytes", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "sdk-candidate-registry-"));
  let registry;
  try {
    const bytes = Buffer.from("immutable packed fixture");
    const tarball = join(temporary, "candidate.tgz");
    await writeFile(tarball, bytes);
    const manifest = { name: "@zhivex-ai/sdk", version: "1.30.1", dependencies: { "@zhivex-ai/core": "~1.30.0" }, peerDependencies: { react: "^19.0.0" } };
    const original = structuredClone(manifest);
    const integrity = createHash("sha256").update(bytes).digest("hex");
    registry = await startCandidateRegistry([{ manifest, tarball, integrity }]);
    const metadata = await (await fetch(registry.url + "/@zhivex-ai%2Fsdk")).json();
    expect(Object.keys(metadata.versions)).toEqual([manifest.version]);
    expect(metadata.versions[manifest.version]).toMatchObject(original);
    const dist = metadata.versions[manifest.version].dist;
    const installed = Buffer.from(await (await fetch(dist.tarball)).arrayBuffer());
    expect(installed).toEqual(bytes);
    expect(dist.integrity).toBe("sha512-" + createHash("sha512").update(installed).digest("base64"));
    expect((await fetch(registry.url + "/@zhivex-ai/core")).status).toBe(404);
    expect((await fetch(registry.url + "/zod")).status).toBe(404);
    expect((await fetch(registry.url + "/@zhivex-ai/sdk", { method: "POST" })).status).toBe(405);
    expect((await fetch(registry.url + "/%ZZ")).status).toBe(400);
    expect(manifest).toEqual(original);
    await writeFile(tarball, "tampered artifact");
    await expect(startCandidateRegistry([{ manifest, tarball, integrity }])).rejects.toThrow("Candidate tarball changed");
  } finally {
    if (registry) await registry.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

it("resolves an unpublished internal range from the complete unmodified batch, and fails for an incomplete batch", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "sdk-unpublished-batch-"));
  let registry;
  try {
    const packed = [];
    for (const manifest of [
      { name: "@zhivex-ai/core", version: "1.30.0", main: "index.js" },
      { name: "@zhivex-ai/sdk", version: "1.30.1", main: "index.js", dependencies: { "@zhivex-ai/core": "~1.30.0" } }
    ]) {
      const directory = join(temporary, manifest.name.split("/")[1]);
      await mkdir(join(directory, "package"), { recursive: true });
      await writeFile(join(directory, "package/package.json"), JSON.stringify(manifest));
      await writeFile(join(directory, "package/index.js"), "module.exports = {};\n");
      const tarball = join(directory, "candidate.tgz");
      execFileSync("tar", ["-czf", tarball, "-C", directory, "package"]);
      const integrity = createHash("sha256").update(await readFile(tarball)).digest("hex");
      packed.push({ manifest, tarball, integrity });
    }
    for (const complete of [false, true]) {
      registry = await startCandidateRegistry(complete ? packed : [packed[1]]);
      const consumer = join(temporary, complete ? "complete" : "incomplete");
      await mkdir(consumer);
      const manifest = { private: true, dependencies: { "@zhivex-ai/sdk": `file:${packed[1].tarball}` } };
      await writeFile(join(consumer, "package.json"), JSON.stringify(manifest));
      const npmrc = join(consumer, ".npmrc");
      // Every request stays on loopback, with an isolated cache and no credentials.
      await writeFile(npmrc, `registry=${registry.url}\n`);
      const { code, output } = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumer, env: { ...process.env, NPM_CONFIG_REGISTRY: registry.url, NPM_CONFIG_USERCONFIG: npmrc, NPM_CONFIG_CACHE: join(consumer, "cache"), NPM_CONFIG_UPDATE_NOTIFIER: "false", NODE_OPTIONS: "" } });
        let output = "";
        child.stdout.on("data", value => output += value);
        child.stderr.on("data", value => output += value);
        child.on("error", reject);
        child.on("close", code => resolve({ code, output }));
      });
      if (complete) {
        expect(code, output).toBe(0);
        const installed = JSON.parse(await readFile(join(consumer, "node_modules/@zhivex-ai/core/package.json"), "utf8"));
        expect(installed).toEqual(packed[0].manifest);
        expect(JSON.parse(await readFile(join(consumer, "node_modules/@zhivex-ai/sdk/package.json"), "utf8"))).toEqual(packed[1].manifest);
      } else {
        expect(code).not.toBe(0);
        expect(output).toContain("@zhivex-ai/core");
      }
      expect(JSON.parse(await readFile(join(consumer, "package.json"), "utf8"))).toEqual(manifest);
      await registry.close(); registry = undefined;
    }
  } finally {
    if (registry) await registry.close();
    await rm(temporary, { recursive: true, force: true });
  }
}, 30_000);
