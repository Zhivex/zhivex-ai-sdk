import assert from "node:assert/strict";

import type { LanguageModel } from "@zhivex-ai/core/contracts";
import * as core from "@zhivex-ai/core";
import * as contracts from "@zhivex-ai/core/contracts";
import * as nodeCore from "@zhivex-ai/core/node";
import * as runtime from "@zhivex-ai/core/runtime";
import * as testing from "@zhivex-ai/core/testing";
import * as ui from "@zhivex-ai/core/ui";
import * as workflows from "@zhivex-ai/core/workflows";

const acceptsModel = (_model: LanguageModel) => undefined;
void acceptsModel;

assert.deepEqual(Object.keys(contracts), []);
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
