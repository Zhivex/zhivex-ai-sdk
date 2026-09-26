import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { builtinModules } from "node:module";
import { expect, it } from "vitest";
import core from "../../core/package.json" with { type: "json" };

it("keeps the complete unbundled browser module graph free of server imports", () => {
  const root = resolve(import.meta.dirname, "../../..");
  const visited = new Set<string>();
  const forbidden: string[] = [];
  function walk(file: string) {
    if (visited.has(file)) return;
    visited.add(file);
    // Follow static runtime imports and re-exports without tree shaking.
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:import|export)\s+(type\s+)?(?:[^;]*?\sfrom\s*)?["']([^"']+)["']/g)) {
      if (!match[1]) {
        const id = match[2]!;

        if (id.startsWith("node:") || builtinModules.includes(id) || id === "@zhivex-ai/core/provider") forbidden.push(`${file}: ${id}`);
        else if (id.startsWith(".")) walk(resolve(dirname(file), id.replace(/\.js$/, ".ts")));
        else if (id.startsWith("@zhivex-ai/core")) {
          const key = id === "@zhivex-ai/core" ? "." : `.${id.slice("@zhivex-ai/core".length)}`;
          const entry = core.exports[key as keyof typeof core.exports];
          expect(entry, id).toBeDefined();
          walk(resolve(root, "packages/core/src", entry.import.replace("./dist/", "").replace(/\.js$/, ".ts")));
        } else if (id.startsWith("#")) {
          const entry = core.imports[id as keyof typeof core.imports];
          expect(entry, id).toBeDefined();
          walk(resolve(root, "packages/core/src", entry.browser.replace("./dist/", "").replace(/\.js$/, ".ts")));
        } else expect(["zod"], `Unexpected browser dependency: ${id}`).toContain(id);
      }
    }
  }
  walk(resolve(root, "packages/qwen/src/browser.ts"));
  expect(forbidden).toEqual([]);
  expect(visited.size).toBeGreaterThan(3);
});
