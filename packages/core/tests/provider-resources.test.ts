import { readFile } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import * as googleTools from "../src/google.js";
import * as core from "../src/index.js";
import * as providerResources from "../src/provider-resources.js";

const resourceExports = [
  "cancelBatch",
  "cancelInteraction",
  "createBatch",
  "createContextCache",
  "createFileSearchStore",
  "createInteraction",
  "deleteBatch",
  "deleteContextCache",
  "deleteFile",
  "deleteFileSearchStore",
  "deleteInteraction",
  "fetchPredictionOperation",
  "getBatch",
  "getContextCache",
  "getFile",
  "getFileSearchStore",
  "getInteraction",
  "importFileToFileSearchStore",
  "listBatches",
  "listContextCaches",
  "listFileSearchStores",
  "listFiles",
  "predictLongRunning",
  "predictRaw",
  "resumeInteraction",
  "streamInteraction",
  "uploadFile",
  "uploadToFileSearchStore"
] as const;

const googleToolExports = [
  "googleCodeExecutionTool",
  "googleComputerUseTool",
  "googleFileSearchTool",
  "googleMapsTool",
  "googleSearchTool",
  "googleUrlContextTool"
] as const;

describe("provider resource module boundary", () => {
  it("keeps the root exports compatible while assigning each symbol to its focused module", () => {
    expect(Object.keys(providerResources).sort()).toEqual([...resourceExports].sort());
    expect(Object.keys(googleTools).sort()).toEqual([...googleToolExports].sort());

    const rootExports = core as Record<string, unknown>;
    const resourceModule = providerResources as Record<string, unknown>;
    const googleModule = googleTools as Record<string, unknown>;

    for (const name of resourceExports) {
      expect(rootExports[name], name).toBe(resourceModule[name]);
    }
    for (const name of googleToolExports) {
      expect(rootExports[name], name).toBe(googleModule[name]);
    }
  });

  it("keeps provider-resources free of provider-specific module dependencies", async () => {
    const filePath = path.resolve(import.meta.dirname, "../src/provider-resources.ts");
    const source = await readFile(filePath, "utf8");
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const dependencies = sourceFile.statements.flatMap((statement) => {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        return [];
      }
      return [statement.moduleSpecifier.text];
    });

    expect(dependencies.sort()).toEqual(["./errors.js", "./types.js"]);
    expect(dependencies).not.toContain("./google.js");
  });
});
