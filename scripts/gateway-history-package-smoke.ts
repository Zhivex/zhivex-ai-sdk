import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const live = process.argv.includes("--live");
const provider = process.argv.find((arg) => arg.startsWith("--provider="))?.split("=")[1] ?? "anthropic";
const api = process.argv.find((arg) => arg.startsWith("--api="))?.split("=")[1];
if (api !== undefined && !["chat", "responses", "messages"].includes(api)) throw new Error("Unsupported smoke API.");
const credentials: Record<string, boolean> = {
  anthropic: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  openai: Boolean(process.env.OPENAI_API_KEY),
  deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
  qwen: Boolean(process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY)
};
if (!Object.hasOwn(credentials, provider)) throw new Error("Unsupported smoke provider.");
if (live && !credentials[provider]) {
  console.error(`GATEWAY_HISTORY_LIVE_BLOCKED: missing ${provider} credential.`);
  process.exit(2);
}
const directory = mkdtempSync(join(tmpdir(), "zhivex-gateway-history-"));
const packs = join(directory, "packs");
const consumer = join(directory, "consumer");
mkdirSync(packs);
mkdirSync(consumer);
const env = { ...process.env, TMPDIR: directory, BUN_INSTALL_CACHE_DIR: join(directory, "bun-cache") };
let stage = "pack";
function run(command: string, args: string[], cwd: string) {
  return execFileSync(command, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
}
try {
  const artifacts: Array<{ name: string; version: string; path: string; sha512: string }> = [];
  const dependencies: Record<string, string> = { "@zhivex-ai/anthropic": "0.9.0", zod: "4.4.3" };
  for (const name of ["core", "sdk", "gateway", "openai", "deepseek", "qwen"]) {
    const path = join(packs, name + ".tgz");
    run("bun", ["pm", "pack", "--ignore-scripts", "--filename", path], join(root, "packages", name));
    const manifest = JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8"));
    artifacts.push({ name: manifest.name, version: manifest.version, path, sha512: createHash("sha512").update(readFileSync(path)).digest("hex") });
    dependencies[manifest.name] = path;
  }
  writeFileSync(join(consumer, "package.json"), JSON.stringify({
    name: "gateway-history-consumer", private: true, type: "module", dependencies,
    devDependencies: { typescript: "6.0.3", "@types/node": "25.9.5" },
    overrides: { "@zhivex-ai/core": dependencies["@zhivex-ai/core"] }
  }));
  writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, types: ["node"], skipLibCheck: true, noEmit: true }, include: ["smoke.ts"] }));
  writeFileSync(join(consumer, "smoke.ts"), readFileSync(join(root, "scripts/fixtures/gateway-history-consumer.ts"), "utf8"));
  stage = "install";
  run("bun", ["install", "--ignore-scripts"], consumer);
  stage = "typecheck";
  run("bun", ["x", "--no-install", "tsc", "--project", "tsconfig.json"], consumer);
  stage = live ? "live continuation" : "mock continuation";
  const result = run("bun", ["run", "smoke.ts", ...(live ? ["--live", "--provider=" + provider, ...(api ? ["--api=" + api] : [])] : [])], consumer).trim();
  const evidence = { artifacts, installedAnthropic: "0.9.0", consumer, result: JSON.parse(result), published: false };
  writeFileSync(join(directory, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  if (stage === "live continuation" || stage === "mock continuation") {
    try {
      const result = JSON.parse(String((error as { stdout?: string }).stdout));
      console.error(JSON.stringify({ status: "failed", operation: result.operation === "generate" ? "generate" : "stream", httpStatus: typeof result.httpStatus === "number" ? result.httpStatus : undefined, calls: typeof result.calls === "number" ? result.calls : undefined }));
    } catch { /* Raw subprocess diagnostics may contain private content. */ }
  }
  console.error("GATEWAY_HISTORY_SMOKE_FAILED at " + stage + ": no provider payloads or credentials logged. Consumer directory: " + consumer);
  process.exitCode = 1;
}
