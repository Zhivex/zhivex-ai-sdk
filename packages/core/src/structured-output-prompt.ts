import { toJSONSchema, type ZodTypeAny } from "zod";

import { ValidationError } from "./errors.js";

export const createStructuredOutputPrompt = (
  schema: ZodTypeAny,
  options: {
    name?: string;
    description?: string;
  } = {}
): string => {
  let jsonSchema: unknown;
  try {
    jsonSchema = toJSONSchema(schema, {
      target: "draft-07",
      io: "input",
      unrepresentable: "throw"
    });
  } catch (error) {
    throw new ValidationError(
      "Structured output schema cannot be represented as JSON Schema for prompted mode.",
      { cause: error }
    );
  }

  return [
    "Return only valid JSON that conforms to the following JSON Schema.",
    "Do not include Markdown fences or explanatory text.",
    options.name ? `Output name: ${options.name}` : undefined,
    options.description ? `Output description: ${options.description}` : undefined,
    "JSON Schema:",
    JSON.stringify(jsonSchema)
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
};
