import assert from "node:assert/strict";

import * as sdk from "@zhivex-ai/sdk";
import * as beta from "@zhivex-ai/sdk/beta";
import { defaultModelCatalog } from "@zhivex-ai/sdk/catalog";
import * as experimental from "@zhivex-ai/sdk/experimental";

assert.equal(typeof sdk.generateText, "function");
assert.equal(typeof beta.createMergedAbortSignal, "function");
assert.equal(typeof beta.deriveLegacyModelCapabilities, "function");
assert.equal(typeof experimental.createAdvancedToolRegistry, "function");
assert.equal(defaultModelCatalog.metadata.contractVersion, "1");

console.log("@zhivex-ai/sdk dist entrypoints: ok");
