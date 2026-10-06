/** Explicitly opt-in Experimental APIs with no compatibility guarantee. */
export {
  AdvancedToolRegistry,
  createAdvancedToolRegistry,
  createHttpTool,
  createToolPermissionPreset,
  createToolTestFixture,
  experimentalRawProviderOptions,
  googleCodeExecutionTool,
  googleComputerUseTool,
  googleFileSearchTool,
  googleMapsTool,
  googleSearchTool,
  googleUrlContextTool,
  inspectToolRegistry,
  recordToolTestFixture,
  runToolTestFixture,
  runComputerUse,
  ComputerUseExecutionError,
  testToolDefinition,
  testToolRegistry
} from "@zhivex-ai/core/experimental";

export type { ExperimentalRawProviderOptions } from "@zhivex-ai/core/experimental";
export type { ComputerUseCallbackContext, ComputerAction, ComputerUseEnvironment, ComputerUseResult, RunComputerUseOptions } from "@zhivex-ai/core/experimental";
