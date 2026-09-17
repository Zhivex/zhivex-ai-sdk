import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
if (process.env.ZHIVEX_WEEKLY_LIVE !== "1")
    throw new Error("Set ZHIVEX_WEEKLY_LIVE=1 to authorize billed live calls.");
const root = resolve(import.meta.dir, "..");
const output = resolve(process.env.ZHIVEX_LIVE_REPORT ?? join(root, `docs/evidence/weekly-provider-live-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
if (existsSync(output))
    throw new Error("Refusing to overwrite an existing evidence file; choose ZHIVEX_LIVE_REPORT.");
const temp = mkdtempSync(join(tmpdir(), "zhivex-weekly-live-"));
const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
try {
    const dependencies: Record<string, string> = Object.fromEntries(["ws", "zod"].map(name => [name, JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")).version]));
    const artifacts = [];
    for (const name of ["core", "sdk", "deepseek", "gemini", "anthropic", "openai", "qwen"]) {
        const dir = join(root, "packages", name);
        const file = join(temp, `${name}.tgz`);
        execFileSync("bun", ["pm", "pack", "--quiet", "--filename", file], { cwd: dir, stdio: "pipe" });
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        dependencies[pkg.name] = `file:${file}`;
        artifacts.push({ name: pkg.name, version: pkg.version, tarballSha256: hash(readFileSync(file)), entrySha256: hash(readFileSync(join(dir, "dist/index.js"))) });
    }
    writeFileSync(join(temp, "package.json"), JSON.stringify({ private: true, type: "module", dependencies, overrides: { "@zhivex-ai/core": dependencies["@zhivex-ai/core"] } }));
    execFileSync("bun", ["install", "--ignore-scripts"], { cwd: temp, stdio: "pipe" });
    copyFileSync(join(root, "scripts/weekly-provider-installed-live.mjs"), join(temp, "live.mjs"));
    const transport = new Bun.Transpiler({ loader: "ts" }).transformSync(readFileSync(join(root, "scripts/lib/openai-live-smoke-transport.ts"), "utf8"));
    writeFileSync(join(temp, "transport.js"), transport);
    mkdirSync(resolve(output, ".."), { recursive: true });
    const manifest = { startedAt: new Date().toISOString(), baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), trackedDiffSha256: hash(execFileSync("git", ["diff", "HEAD"], { cwd: root })), fixtureSha256: hash(readFileSync(join(root, "scripts/weekly-provider-installed-live.mjs"))), lockfileSha256: hash(readFileSync(join(root, "bun.lock"))), consumerDependencies: { ws: dependencies.ws, zod: dependencies.zod }, artifacts };
    writeFileSync(output, JSON.stringify({ ...manifest, results: [] }, null, 2));
    execFileSync("bun", [join(temp, "live.mjs")], { cwd: temp, env: { ...process.env, ZHIVEX_LIVE_REPORT: output }, stdio: "inherit", timeout: 600000 });
}
catch (error) {
    console.error(`Live certification failed; inspect ${output}.`);
    process.exitCode = 1;
}
finally {
    rmSync(temp, { recursive: true, force: true });
}
