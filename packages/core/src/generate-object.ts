import type { ZodTypeAny } from "zod";

import { ParseError, ValidationError } from "./errors.js";
import { generateText } from "./generate-text.js";
import type { GenerateObjectOptions, GenerateObjectOutput } from "./types.js";

export const generateObject = async <TSchema extends ZodTypeAny>(
  options: GenerateObjectOptions<TSchema>
): Promise<GenerateObjectOutput<TSchema>> => {
  const textResult = await generateText(options);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(textResult.text);
  } catch (error) {
    throw new ParseError("Model response is not valid JSON.", { cause: error });
  }

  const parsed = options.schema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new ValidationError(`Structured output validation failed: ${parsed.error.message}`);
  }

  return {
    ...textResult,
    object: parsed.data
  };
};
