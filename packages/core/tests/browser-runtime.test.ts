import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const sourceRoot = path.resolve(import.meta.dirname, "../src");

const sourceFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const fullPath = path.join(directory, entry.name);
  if (entry.isDirectory()) return sourceFiles(fullPath);
  return entry.name.endsWith(".ts") ? [fullPath] : [];
});

describe("browser-safe core runtime", () => {
  it("does not import node:util from the published core source", () => {
    const hits = sourceFiles(sourceRoot).filter((file) => /from\s+["']node:util["']/.test(readFileSync(file, "utf8")));
    expect(hits).toEqual([]);
  });
});
