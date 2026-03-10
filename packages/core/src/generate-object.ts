import type { ZodTypeAny } from "zod";

import { ParseError, UnsupportedFeatureError, ValidationError } from "./errors.js";
import { createTextMessage } from "./messages.js";
import { generateText, normalizeMessages } from "./generate-text.js";
import type { GenerateObjectOptions, GenerateObjectOutput } from "./types.js";

export const generateObject = async <TSchema extends ZodTypeAny>(
  options: GenerateObjectOptions<TSchema>
): Promise<GenerateObjectOutput<TSchema>> => {
  const requestedMode = options.mode ?? "auto";
  const nativeAllowed = options.model.capabilities.structuredOutput;
  const objectMode = requestedMode === "auto" ? (nativeAllowed ? "native" : "prompted") : requestedMode;

  if (objectMode === "native" && !nativeAllowed) {
    throw new UnsupportedFeatureError(
      `Model "${options.model.provider}/${options.model.modelId}" does not support native structured output.`
    );
  }

  const textResult = await generateText({
    ...options,
    prompt:
      objectMode === "prompted" && options.prompt
        ? `${options.prompt}\n\nReturn only valid JSON matching the requested schema.`
        : options.prompt,
    messages:
      objectMode === "prompted" && options.messages
        ? [
            ...options.messages,
            createTextMessage("system", "Return only valid JSON matching the requested schema.")
          ]
        : options.messages
  });

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
    object: parsed.data,
    objectMode
  };
};
