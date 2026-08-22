import assert from "node:assert/strict";

import * as sdk from "@zhivex-ai/sdk";
import * as beta from "@zhivex-ai/sdk/beta";
import { defaultModelCatalog } from "@zhivex-ai/sdk/catalog";
import * as experimental from "@zhivex-ai/sdk/experimental";
import * as evals from "@zhivex-ai/sdk/evals";
import * as runtime from "@zhivex-ai/sdk/runtime";
import * as ui from "@zhivex-ai/sdk/ui";
import * as workflows from "@zhivex-ai/sdk/workflows";

assert.equal(typeof sdk.generateText, "function");
assert.equal(typeof beta.createMergedAbortSignal, "function");
assert.equal(typeof beta.deriveLegacyModelCapabilities, "function");
assert.equal(typeof experimental.createAdvancedToolRegistry, "function");
assert.equal(typeof experimental.experimentalRawProviderOptions, "function");
assert.equal(typeof evals.runModelEvaluation, "function");
assert.equal(typeof runtime.generateText, "function");
assert.equal(typeof ui.toUIMessage, "function");
assert.equal(typeof workflows.createWorkflow, "function");
assert.equal(defaultModelCatalog.metadata.contractVersion, "1");

console.log("@zhivex-ai/sdk dist entrypoints: ok");
