import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "@typescript/typescript6";

type Manifest = { name: string; version?: string; [field: string]: unknown };
const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/** Update release metadata only; never re-resolve or reserialize external packages. */
export function alignLockWorkspaces(source: string, manifests: Record<string, Manifest>): string {
  const parsed = ts.parseConfigFileTextToJson("bun.lock", source);
  assert.ok(!parsed.error, "Invalid Bun lockfile");
  const lock = parsed.config;
  assert.equal(lock.lockfileVersion, 1, "Unsupported Bun lockfile format");
  assert.deepEqual(Object.keys(lock.workspaces).sort(), Object.keys(manifests).sort(), "Workspace inventory changed; regenerate the lockfile with Bun");
  const edits: { start: number; end: number; value: string }[] = [];
  const tree = ts.parseJsonText("bun.lock", source);
  const object = (tree.statements[0] as ts.ExpressionStatement).expression as ts.ObjectLiteralExpression;
  const properties = (value: ts.ObjectLiteralExpression) => value.properties as ts.NodeArray<ts.PropertyAssignment>;
  const workspaces = properties(object).find(node => node.name.getText(tree) === '"workspaces"')!.initializer as ts.ObjectLiteralExpression;
  for (const workspace of properties(workspaces)) {
    const key = JSON.parse(workspace.name.getText(tree));
    const manifest = manifests[key];
    const snapshot = lock.workspaces[key];
    assert.equal(snapshot.name, manifest.name, `Workspace name mismatch: ${key}`);
    for (const field of dependencyFields) {
      const expected = (manifest[field] ?? {}) as Record<string, string>;
      const actual = snapshot[field] ?? {};
      assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `Dependency inventory changed: ${key}/${field}; regenerate with Bun`);
      for (const [name, range] of Object.entries(expected)) {
        if (!name.startsWith("@zhivex-ai/")) assert.equal(actual[name], range, `External dependency changed: ${key}/${name}; regenerate with Bun`);
      }
    }
    assert.deepEqual(snapshot.optionalPeers ?? [], Object.entries((manifest.peerDependenciesMeta ?? {}) as Record<string, { optional?: boolean }>).filter(([, value]) => value.optional).map(([name]) => name).sort(), `Optional peers changed: ${key}; regenerate with Bun`);
    for (const property of properties(workspace.initializer as ts.ObjectLiteralExpression)) {
      const field = JSON.parse(property.name.getText(tree));
      if (field === "version") {
        assert.equal(typeof manifest.version, "string", `Missing workspace version: ${key}`);
        if (snapshot.version !== manifest.version) edits.push({ start: property.initializer.getStart(tree), end: property.initializer.end, value: JSON.stringify(manifest.version) });
      } else if (dependencyFields.includes(field)) {
        for (const dependency of properties(property.initializer as ts.ObjectLiteralExpression)) {
          const name = JSON.parse(dependency.name.getText(tree));
          const range = (manifest[field] as Record<string, string>)[name];
          if (name.startsWith("@zhivex-ai/") && snapshot[field][name] !== range) edits.push({ start: dependency.initializer.getStart(tree), end: dependency.initializer.end, value: JSON.stringify(range) });
        }
      }
    }
    assert.equal(Object.hasOwn(snapshot, "version"), Object.hasOwn(manifest, "version"), `Version field changed: ${key}; regenerate with Bun`);
  }
  return edits.sort((a, b) => b.start - a.start).reduce((text, edit) => text.slice(0, edit.start) + edit.value + text.slice(edit.end), source);
}

export async function syncLockWorkspaces(repoRoot: string, check = false): Promise<boolean> {
  const manifests: Record<string, Manifest> = { "": JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) };
  for (const entry of await readdir(path.join(repoRoot, "packages"), { withFileTypes: true })) {
    if (entry.isDirectory()) manifests[`packages/${entry.name}`] = JSON.parse(await readFile(path.join(repoRoot, "packages", entry.name, "package.json"), "utf8"));
  }
  const lockPath = path.join(repoRoot, "bun.lock");
  const original = await readFile(lockPath, "utf8");
  const aligned = alignLockWorkspaces(original, manifests);
  if (check && original !== aligned) throw new Error("Bun workspace snapshots are stale; run bun scripts/sync-lock-workspaces.ts");
  if (original !== aligned) await writeFile(lockPath, aligned);
  return original !== aligned;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await syncLockWorkspaces(path.resolve(import.meta.dirname, ".."), process.argv.includes("--check"));
  console.log("Bun workspace release snapshots are aligned.");
}
