import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "zhivex-react-consumer-"));
const packs = join(temporary, "packs");
const consumer = join(temporary, "consumer");
await mkdir(packs); await mkdir(consumer);
const run = async (cmd: string[], cwd: string) => {
  const process = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (exit) throw new Error(`${cmd.slice(0, 3).join(" ")} failed: ${stderr}\n${stdout}`);
  return stdout.trim();
};
const corePack = await run(["bun", "pm", "pack", "--destination", packs, "--quiet", "--ignore-scripts"], join(root, "packages/core"));
const reactPack = await run(["bun", "pm", "pack", "--destination", packs, "--quiet", "--ignore-scripts"], join(root, "packages/react"));
const resolvePack = (value: string) => value.startsWith("/") ? value : join(packs, value);
const repo = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "react-consumer-smoke", private: true, type: "module", dependencies: {
  "@zhivex-ai/core": `file:${resolvePack(corePack)}`, "@zhivex-ai/react": `file:${resolvePack(reactPack)}`,
  react: repo.devDependencies.react, "react-dom": repo.devDependencies["react-dom"]
} }));
await run(["bun", "install", "--ignore-scripts"], consumer);
await writeFile(join(consumer, "smoke.mjs"), `
import assert from "node:assert/strict";
for (const subpath of ["", "/hooks", "/headless", "/transport", "/components", "/replay"]) {
  assert.ok(Object.keys(await import("@zhivex-ai/react" + subpath)).length);
}
for (const peer of ["react-markdown", "remark-gfm", "@tanstack/react-virtual"]) {
  await assert.rejects(import(peer));
}
console.log("Native React entrypoints load without optional UI peers.");
`);
console.log(await run(["node", "smoke.mjs"], consumer));
await run(["bun", "add", "--ignore-scripts", "react-markdown@10.1.0", "remark-gfm@4.0.1", "@tanstack/react-virtual@3.14.13"], consumer);
await writeFile(join(consumer, "optional.mjs"), `
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "@zhivex-ai/react/markdown";
import { VirtualizedMessageList } from "@zhivex-ai/react/virtualized";
assert.match(renderToStaticMarkup(createElement(MarkdownContent, { children: "**packed**" })), /<strong>packed<\\/strong>/);
assert.equal(typeof VirtualizedMessageList, "function");
console.log("Packed optional Markdown and virtualized entrypoints load and render.");
`);
console.log(await run(["node", "optional.mjs"], consumer));
console.log(`Packed consumer evidence: ${temporary}`);
