import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const sourceDirectory = path.resolve(import.meta.dirname, "../src");
const relativeModulePattern = /(?:import|export)\s+(?:type\s+)?(?:[^;'"`]*?\s+from\s+)?["'](\.[^"']+)["']/g;

const sourceFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(filePath);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [filePath] : [];
  }));
  return nested.flat();
};

const dependencyGraph = async (): Promise<Map<string, string[]>> => {
  const files = await sourceFiles(sourceDirectory);
  const knownFiles = new Set(files);
  const graph = new Map<string, string[]>();

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const dependencies = [...source.matchAll(relativeModulePattern)]
      .map((match) => match[1])
      .filter((specifier): specifier is string => specifier !== undefined)
      .map((specifier) => path.resolve(path.dirname(file), specifier.replace(/\.js$/, ".ts")))
      .filter((dependency) => knownFiles.has(dependency));
    graph.set(file, [...new Set(dependencies)]);
  }

  return graph;
};

const findDependencyPath = (
  graph: Map<string, string[]>,
  from: string,
  to: string,
  visited = new Set<string>()
): string[] | undefined => {
  if (from === to) {
    return [from];
  }
  if (visited.has(from)) {
    return undefined;
  }
  visited.add(from);
  for (const dependency of graph.get(from) ?? []) {
    const nestedPath = findDependencyPath(graph, dependency, to, visited);
    if (nestedPath) {
      return [from, ...nestedPath];
    }
  }
  return undefined;
};

const findCycles = (graph: Map<string, string[]>): string[][] => {
  const cycles = new Map<string, string[]>();
  const visit = (current: string, stack: string[]): void => {
    const cycleStart = stack.indexOf(current);
    if (cycleStart >= 0) {
      const cycle = [...stack.slice(cycleStart), current];
      const nodes = cycle.slice(0, -1);
      const rotations = nodes.map((_, index) => [
        ...nodes.slice(index),
        ...nodes.slice(0, index)
      ]);
      const canonical = rotations
        .map((rotation) => rotation.map((file) => path.basename(file)).join(" -> "))
        .sort()[0]!;
      cycles.set(canonical, cycle);
      return;
    }
    for (const dependency of graph.get(current) ?? []) {
      visit(dependency, [...stack, current]);
    }
  };

  for (const module of graph.keys()) {
    visit(module, []);
  }
  return [...cycles.values()];
};

describe("workflow source dependencies", () => {
  it("keeps workflow runtime and state-service implementation acyclic", async () => {
    const graph = await dependencyGraph();
    const workflow = path.join(sourceDirectory, "workflow.ts");
    const stateService = path.join(sourceDirectory, "workflow-state-service.ts");
    const contracts = path.join(sourceDirectory, "workflow-state-contracts.ts");

    expect(graph.get(workflow)).toContain(contracts);
    expect(graph.get(stateService)).toContain(contracts);
    expect(findDependencyPath(graph, workflow, stateService)).toBeUndefined();
    expect(findDependencyPath(graph, stateService, workflow)).toBeUndefined();
  });

  it("keeps all core source modules acyclic", async () => {
    const cycles = findCycles(await dependencyGraph()).map((cycle) =>
      cycle.map((file) => path.basename(file)).join(" -> ")
    );

    expect(cycles).toEqual([]);
  });
});
