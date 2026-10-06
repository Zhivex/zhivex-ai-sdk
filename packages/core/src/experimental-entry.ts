/** Focused experimental surface; preserves the root implementation identities. */
export {
  AdvancedToolRegistry,
  createAdvancedToolRegistry,
  createHttpTool,
  createToolPermissionPreset,
  createToolTestFixture,
  inspectToolRegistry,
  recordToolTestFixture,
  runToolTestFixture,
  testToolDefinition,
  testToolRegistry
} from "./advanced-tool-registry.js";
export { experimentalRawProviderOptions } from "./raw-provider-options.js";
export {
  googleCodeExecutionTool,
  googleComputerUseTool,
  googleFileSearchTool,
  googleMapsTool,
  googleSearchTool,
  googleUrlContextTool
} from "./google.js";
export type { ExperimentalRawProviderOptions } from "./raw-provider-options.js";
export { runComputerUse, ComputerUseExecutionError } from "./computer-use.js";
export type { ComputerUseCallbackContext, ComputerAction, ComputerUseEnvironment, ComputerUseResult, RunComputerUseOptions } from "./computer-use.js";

export { experimentalDecisionHelpers } from "./decision-helpers.js";
export type { DecisionQuestion, DecisionQuestions, DecisionEvidence, DecisionInput, DecisionCapabilities, DecisionAnswer, DecisionResult, DecisionModel } from "./decisions.js";
