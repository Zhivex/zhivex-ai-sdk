import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const repoRoot = path.resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "zhivex-doc-examples-"));
const execFileAsync = promisify(execFile);

try {
  // Only complete, runnable snippets belong here. Recipes may deliberately use app-owned variables.
  const inputs = [
    { file: "packages/core/README.md", section: "## Usage" },
    { file: "packages/sdk/README.md", section: "## Quick Start" },
    { file: "packages/agents/README.md", section: "## Quick Start" },
    { file: "README.md", section: "## Quick Start" },
    { file: "docs/QUICKSTART.md", section: "## 2. Get The First Response" },
    { file: "docs/QUICKSTART.md", section: "## 3. Add A Persistent Agent" }
  ];
  const files: string[] = [];
  for (const [index, input] of inputs.entries()) {
    const markdown = await readFile(path.join(repoRoot, input.file), "utf8");
    const start = markdown.indexOf(input.section);
    if (start === -1) throw new Error(`${input.file}: missing ${input.section}`);
    const remainder = markdown.slice(start + input.section.length);
    const nextHeading = remainder.search(/^## /m);
    const section = nextHeading === -1 ? remainder : remainder.slice(0, nextHeading);
    const snippet = section.match(/```ts\s*\n([\s\S]*?)\n```/)?.[1];
    if (!snippet) throw new Error(`${input.file}: missing complete TypeScript example in ${input.section}`);
    const file = path.join(temporary, `example-${index}.ts`);
    await writeFile(file, `// ${input.file}: ${input.section}\n${snippet}\n`);
    files.push(file);
  }

  await symlink(path.join(repoRoot, "node_modules"), path.join(temporary, "node_modules"), "dir");
  await writeFile(path.join(temporary, "package.json"), '{"type":"module"}\n');
  const base = JSON.parse(await readFile(path.join(repoRoot, "tsconfig.base.json"), "utf8"));
  const core = JSON.parse(await readFile(path.join(repoRoot, "packages/core/package.json"), "utf8"));
  const paths = Object.fromEntries(Object.entries(base.compilerOptions.paths as Record<string, string[]>)
    .map(([name, targets]) => [name, targets.map((target) => path.resolve(repoRoot, target))]));
  paths["@zhivex-ai/agents"] = [path.join(repoRoot, "packages/agents/src/index.ts")];
  for (const [subpath, target] of Object.entries(core.exports) as Array<[string, { import: string }]>) {
    if (subpath === ".") continue;
    paths[`@zhivex-ai/core/${subpath.slice(2)}`] = [path.join(repoRoot, "packages/core/src", target.import.replace("./dist/", "").replace(/\.js$/, ".ts"))];
  }
  await writeFile(path.join(temporary, "tsconfig.json"), JSON.stringify({
    extends: path.join(repoRoot, "tsconfig.base.json"),
    compilerOptions: { composite: false, declaration: false, declarationMap: false, noEmit: true, rootDir: "/", paths },
    files,
    include: []
  }));
  await execFileAsync(path.join(repoRoot, "node_modules/.bin/tsc"), ["-p", path.join(temporary, "tsconfig.json"), "--pretty", "false"], { cwd: repoRoot });
  console.log(`Documentation examples passed: ${files.length} complete examples typechecked; no provider calls executed.`);
} catch (error) {
  const result = error as Error & { stdout?: string; stderr?: string };
  console.error(result.stdout || result.stderr || result.message);
  process.exitCode = 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
