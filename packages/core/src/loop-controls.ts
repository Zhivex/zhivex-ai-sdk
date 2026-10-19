import { ValidationError } from "./errors.js";
import { validateMaxSteps } from "./validate-max-steps.js";
import type { GenerateTextStep, StopCondition } from "./types.js";
import type { ToolSet } from "./types.js";

export const stepCountIs = (count: number): StopCondition => {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new ValidationError("stepCountIs requires a positive integer.");
  }
  return ({ stepCount }) => stepCount >= count;
};

/** Stop after a step that contains a tool call. Pass a name to match one tool. */
export const hasToolCall = (name?: string): StopCondition => ({ steps }) => steps.some((step) =>
  (step.response.messages ?? []).some((message) => message.parts.some((part) =>
    part.type === "tool-call" && (name === undefined || part.toolCall.name === name)
  ))
);

export const resolveStepCeiling = (options: {
  maxSteps?: number | "unlimited";
  stopWhen?: StopCondition | readonly StopCondition[];
}): number | "unlimited" => {
  if (options.maxSteps !== undefined) return validateMaxSteps(options.maxSteps);
  if (options.stopWhen !== undefined) return "unlimited";
  return validateMaxSteps(undefined);
};

export const stopConditionMet = async (
  stopWhen: StopCondition | readonly StopCondition[] | undefined,
  steps: readonly GenerateTextStep[]
): Promise<boolean> => {
  if (stopWhen === undefined) return false;
  const conditions = Array.isArray(stopWhen) ? stopWhen : [stopWhen];
  const context = { steps, stepCount: steps.length };
  for (const condition of conditions) {
    if (await condition(context)) return true;
  }
  return false;
};

export const selectActiveTools = (
  tools: ToolSet | undefined,
  activeTools: readonly string[] | undefined
): ToolSet | undefined => {
  if (!tools || activeTools === undefined) return tools;
  const selected: ToolSet = {};
  for (const name of activeTools) {
    if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(tools, name) || tools[name] === undefined) {
      throw new ValidationError(`activeTools entry "${String(name)}" is not a registered tool.`);
    }
    selected[name] = tools[name];
  }
  return Object.keys(selected).length ? selected : undefined;
};
