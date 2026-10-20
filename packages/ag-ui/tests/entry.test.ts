import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = path.resolve(import.meta.dirname, "../src");

const localImports = (source: string): string[] =>
  Array.from(source.matchAll(/from\s+["'](\.[^"']+)["']/g), (match) => match[1] ?? "");

const walk = (file: string, seen: Set<string>): void => {
  const resolved = path.resolve(file);
  if (seen.has(resolved)) return;
  seen.add(resolved);
  const source = readFileSync(resolved, "utf8");
  expect(source, resolved).not.toMatch(/(?:from|import\s*\()\s*["']node:/);
  expect(source, resolved).not.toMatch(/require\(\s*["']node:/);
  for (const specifier of localImports(source)) {
    const next = path.resolve(path.dirname(resolved), specifier).replace(/\.js$/, ".ts");
    walk(next, seen);
  }
};

describe("@zhivex-ai/ag-ui root entry", () => {
  it("imports no node: built-ins from the package root", () => {
    const seen = new Set<string>();
    walk(path.join(sourceRoot, "index.ts"), seen);
    expect(seen.size).toBeGreaterThan(1);
  });
});
