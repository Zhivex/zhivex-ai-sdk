import assert from "node:assert/strict";

// Use emitted files here: workspace tsconfig aliases can replace package roots
// with source while subpaths resolve to dist. Installed-consumer smoke separately
// verifies public package specifiers and package.json exports.

import type { LanguageModel } from "../dist/contracts.js";
import * as core from "../dist/index.js";
import * as agents from "../dist/agents-entry.js";
import * as generation from "../dist/generation-entry.js";
import * as provider from "../dist/provider-entry.js";
import * as catalog from "../dist/catalog-contracts.js";
import * as contracts from "../dist/contracts.js";
import * as nodeCore from "../dist/node.js";
import * as runtime from "../dist/runtime-entry.js";
import * as testing from "../dist/testing.js";
import * as ui from "../dist/ui-entry.js";
import * as workflows from "../dist/workflows-entry.js";

const acceptsModel = (_model: LanguageModel) => undefined;
void acceptsModel;

assert.deepEqual(Object.keys(contracts), []);
assert.equal(generation.generateText, core.generateText);
assert.equal(agents.Agent, core.Agent);
assert.equal(provider.normalizeMessages, core.normalizeMessages);
assert.equal(catalog.createModelCatalog, core.createModelCatalog);
assert.equal("defaultModelCatalog" in catalog, false);
assert.equal(typeof core.generateText, "function");
assert.equal(typeof nodeCore.generateText, "function");
assert.equal(typeof runtime.createProviderAdapter, "function");
assert.equal(typeof runtime.tool, "function");
assert.equal(typeof workflows.createWorkflow, "function");
assert.equal(typeof ui.toUIMessage, "function");
assert.equal(typeof testing.createMockLanguageModel, "function");

for (const entry of ["ui-entry.js", "workflows-entry.js"]) {
  const result = await Bun.build({
    entrypoints: [new URL(`../dist/${entry}`, import.meta.url).pathname],
    target: "browser",
    minify: true,
    write: false
  });
  assert.equal(result.success, true, `${entry} must bundle for browsers: ${result.logs.join("\n")}`);
  const bundled = (await Promise.all(result.outputs.map((output) => output.text()))).join("\n");
  assert.doesNotMatch(bundled, /node:(?:crypto|buffer|util|events|stream)/u);
  assert.ok(Buffer.byteLength(bundled, "utf8") < 250_000, `${entry} browser bundle unexpectedly large`);
}

console.log("@zhivex-ai/core dist entrypoints: ok");
