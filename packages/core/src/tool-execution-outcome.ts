import type { ToolDefinition } from "./types.js";

/** Internal fail-closed marker shared by application-owned effect executors. */
export const isUnknownToolExecution = (error: unknown): error is Error & { effectsPossible: true; outcome: "unknown"; retryable: false } =>
  error instanceof Error && "effectsPossible" in error && error.effectsPossible === true &&
  "outcome" in error && error.outcome === "unknown" && "retryable" in error && error.retryable === false;

export const unknownToolExecution = (cause: unknown) => Object.assign(
  new Error("Tool execution outcome is unknown; reconcile external effects before retrying.", { cause }),
  { effectsPossible: true as const, outcome: "unknown" as const, retryable: false as const }
);

export const isComputerEffectTool = (tool: ToolDefinition | undefined): boolean =>
  tool?.metadata?.["openai.responses_tool_type"] === "computer";
