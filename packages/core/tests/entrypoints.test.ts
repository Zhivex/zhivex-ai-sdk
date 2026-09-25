import { readFile } from "node:fs/promises";
import path from "node:path";

import ts from "@typescript/typescript6";
import { describe, expect, it } from "vitest";

import * as contracts from "../src/contracts.js";
import * as core from "../src/index.js";
import * as agents from "../src/agents-entry.js";
import * as agentFacade from "../src/agent.js";
import * as agentExecution from "../src/agent/execution.js";
import * as agentDefinition from "../src/agent/definition.js";
import * as agentInstance from "../src/agent/instance.js";
import * as agentGroups from "../src/agent/groups.js";
import * as agentCancellation from "../src/agent/cancellation.js";
import * as generation from "../src/generation-entry.js";
import * as provider from "../src/provider-entry.js";
import * as catalog from "../src/catalog-contracts.js";
import * as nodeCore from "../src/node.js";
import * as runtime from "../src/runtime-entry.js";
import * as testing from "../src/testing.js";
import * as ui from "../src/ui-entry.js";
import * as workflows from "../src/workflows-entry.js";

const sourceRoot = path.resolve(import.meta.dirname, "../src");

const runtimeModuleSpecifiers = (source: string, fileName: string): string[] => {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers: string[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly) {
        continue;
      }
      if (
        clause?.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        !clause.name &&
        clause.namedBindings.elements.every((element) => element.isTypeOnly)
      ) {
        continue;
      }
      if (ts.isStringLiteral(statement.moduleSpecifier)) {
        specifiers.push(statement.moduleSpecifier.text);
      }
    }

    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) {
        continue;
      }
      if (
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.every((element) => element.isTypeOnly)
      ) {
        continue;
      }
      if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        specifiers.push(statement.moduleSpecifier.text);
      }
    }
  }

  return specifiers;
};

const collectRuntimeDependencies = async (entry: string, forbiddenBuiltins = ["node:"]): Promise<Set<string>> => {
  const visited = new Set<string>();

  const visit = async (filePath: string): Promise<void> => {
    if (visited.has(filePath)) {
      return;
    }
    visited.add(filePath);
    const source = await readFile(filePath, "utf8");
    for (const specifier of runtimeModuleSpecifiers(source, filePath)) {
      if (forbiddenBuiltins.some((prefix) => specifier.startsWith(prefix))) {
        throw new Error(`${path.relative(sourceRoot, filePath)} imports ${specifier}`);
      }
      if (specifier === "#realtime-transport") {
        await visit(path.join(sourceRoot, "realtime-browser.ts"));
        continue;
      }
      if (specifier === "#secure-id") {
        await visit(path.join(sourceRoot, "secure-id.ts"));
        continue;
      }
      if (!specifier.startsWith(".")) {
        continue;
      }
      const resolved = path.resolve(path.dirname(filePath), specifier.replace(/\.js$/, ".ts"));
      await visit(resolved);
    }
  };

  await visit(path.join(sourceRoot, entry));
  return visited;
};

describe("core public entrypoints", () => {
  it("keeps the root compatible while exposing focused additive surfaces", () => {
    expect(Object.keys(contracts)).toEqual([]);
    expect(nodeCore.generateText).toBe(core.generateText);
    expect(nodeCore.createFileArtifactService).toBe(core.createFileArtifactService);
    expect(runtime.createProviderAdapter).toBe(core.createProviderAdapter);
    expect(runtime.tool).toBe(core.tool);
    expect(workflows.createWorkflow).toBe(core.createWorkflow);
    expect(workflows.evaluateWorkflowEvaluationGate).toBe(core.evaluateWorkflowEvaluationGate);
    expect(ui.toUIMessage).toBe(core.toUIMessage);
    expect(ui.toUIMessageStreamResponse).toBe(core.toUIMessageStreamResponse);
    expect(testing.createMockLanguageModel).toBe(core.createMockLanguageModel);
    expect(testing.runWorkflowEvaluation).toBe(core.runWorkflowEvaluation);
  });

  it("only re-exports runtime symbols already classified by the root stability contract", () => {
    for (const surface of [runtime, workflows, ui, testing, generation, provider, catalog, agents]) {
      for (const symbol of Object.keys(surface)) {
        expect(core.getApiStability(symbol), symbol).toBeDefined();
      }
    }
  });

  it("publishes all focused subpaths with emitted JavaScript and declarations", async () => {
    const pkg = JSON.parse(
      await readFile(path.resolve(import.meta.dirname, "../package.json"), "utf8")
    ) as { exports: Record<string, { types: string; import: string }> };

    expect(pkg.exports).toEqual({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./contracts": { types: "./dist/contracts.d.ts", import: "./dist/contracts.js" },
      "./runtime": { types: "./dist/runtime-entry.d.ts", import: "./dist/runtime-entry.js" },
      "./workflows": { types: "./dist/workflows-entry.d.ts", import: "./dist/workflows-entry.js" },
      "./node": { types: "./dist/node.d.ts", import: "./dist/node.js" },
      "./ui": { types: "./dist/ui-entry.d.ts", import: "./dist/ui-entry.js" },
      "./testing": { types: "./dist/testing.d.ts", import: "./dist/testing.js" },
      "./generation": { types: "./dist/generation-entry.d.ts", import: "./dist/generation-entry.js" },
      "./provider": { types: "./dist/provider-entry.d.ts", import: "./dist/provider-entry.js" },
      "./catalog": { types: "./dist/catalog-entry.d.ts", import: "./dist/catalog-entry.js" },
      "./agents": { types: "./dist/agents-entry.d.ts", import: "./dist/agents-entry.js" },
      "./mcp-http": { types: "./dist/mcp-http.d.ts", import: "./dist/mcp-http.js" }
    });
  });

  it.each(["contracts.ts", "runtime-entry.ts", "workflows-entry.ts", "ui-entry.ts"])(
    "keeps %s free of transitive node built-in imports",
    async (entry) => {
      await expect(collectRuntimeDependencies(entry)).resolves.toBeInstanceOf(Set);
    }
  );

  it("selects secure ID generation per runtime without dropping Node 18 support", async () => {
    const pkg = JSON.parse(
      await readFile(path.resolve(import.meta.dirname, "../package.json"), "utf8")
    ) as {
      files: string[];
      imports: Record<string, { types: string; browser: string; node: string; default: string }>;
    };
    const webSource = await readFile(path.join(sourceRoot, "secure-id.ts"), "utf8");
    const nodeSource = await readFile(path.join(sourceRoot, "secure-id-node.ts"), "utf8");

    expect(pkg.imports["#secure-id"]).toEqual({
      types: "./secure-id-internal.d.ts",
      browser: "./dist/secure-id.js",
      node: "./dist/secure-id-node.js",
      default: "./dist/secure-id.js"
    });
    expect(pkg.files).toContain("secure-id-internal.d.ts");
    expect(pkg.imports["#realtime-transport"]).toEqual({
      types: "./realtime-transport-internal.d.ts", browser: "./dist/realtime-browser.js",
      node: "./dist/realtime-node.js", default: "./dist/realtime-browser.js"
    });
    expect(pkg.files).toContain("realtime-transport-internal.d.ts");
    expect(await readFile(path.join(sourceRoot, "realtime-browser.ts"), "utf8")).not.toContain('"ws"');
    expect(webSource).not.toContain("node:");
    expect(nodeSource).toContain('from "node:crypto"');
  });
});


describe("focused dependency boundaries", () => {
  it("preserves agent facade exports and function identity after internal modularization", () => {
    const implementations = { ...agentExecution, ...agentDefinition, ...agentInstance, ...agentGroups, ...agentCancellation };
    for (const name of ["Agent", "createAgent", "runAgent", "resumeAgent", "streamAgent",
      "createSubAgentTool", "prepareSubagentsForAgent", "runAgentGroup", "cancelAgentRun", "cancelAgentRunTree"] as const) {
      expect(agentFacade[name]).toBe(implementations[name]);
      expect(core[name]).toBe(implementations[name]);
      expect(agents[name]).toBe(implementations[name]);
    }
    expect(Object.keys(agentFacade).sort()).toEqual(Object.keys(implementations).sort());
  });

  it("preserves the existing generation and provider function identities", () => {
    expect(generation.generateText).toBe(core.generateText);
    expect(generation.streamObject).toBe(core.streamObject);
    expect(generation.wrapLanguageModel).toBe(core.wrapLanguageModel);
    expect(provider.normalizeMessages).toBe(core.normalizeMessages);
    expect(catalog.createModelCatalog).toBe(core.createModelCatalog);
    expect("defaultModelCatalog" in catalog).toBe(false);
  });

  it.each(["generation-entry.ts", "provider-entry.ts", "catalog-contracts.ts"])(
    "%s does not load persistence, agents, or the legacy catalog",
    async (entry) => {
      const dependencies = await collectRuntimeDependencies(entry, ["node:fs", "node:path"]);
      const names = [...dependencies].map((file) => path.relative(sourceRoot, file));
      expect(names).not.toContain("index.ts");
      expect(names).not.toContain("agent.ts");
      expect(names.some((name) => name.startsWith("agent/"))).toBe(false);
      expect(names).not.toContain("catalog.ts");
      expect(names).not.toContain("agent-store.ts");
      expect(names).not.toContain("artifact.ts");
      expect(names).not.toContain("workflow-state-service.ts");
    }
  );

  it("keeps the focused agents runtime independent of backends and the root aggregator", async () => {
    const dependencies = await collectRuntimeDependencies("agents-entry.ts", ["node:fs", "node:path"]);
    const names = [...dependencies].map((file) => path.relative(sourceRoot, file));
    expect(names).not.toContain("index.ts");
    expect(names).not.toContain("catalog.ts");
    expect(names.some((file) => /^(agent-store|artifact|workflow-state-service)([/.])/.test(file))).toBe(false);
  });

  it.each(["agent-store", "workflow-state-service", "artifact"].flatMap((family) =>
    ["memory", "sqlite", "postgres"].map((backend) => `${family}/${backend}.ts`)
  ))("%s does not load filesystem helpers or another backend", async (entry) => {
    const dependencies = await collectRuntimeDependencies(entry, ["node:fs", "node:path"]);
    const family = entry.split("/")[0]!;
    const backends = [...dependencies].map((file) => path.relative(sourceRoot, file))
      .filter((file) => file.startsWith(`${family}/`) && /\/(memory|file|sqlite|postgres)\.ts$/.test(file));
    expect(backends).toEqual([entry]);
  });
});
