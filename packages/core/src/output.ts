import type { ZodTypeAny } from "zod";

import { ParseError, UnsupportedFeatureError, ValidationError } from "./errors.js";
import { isJsonSchema } from "./json-schema.js";
import { createTextMessage } from "./messages.js";
import { createStructuredOutputPrompt } from "./structured-output-prompt.js";
import type { GenerateTextOptions, LanguageModel, ModelMessage, StructuredOutputMode } from "./types.js";

export interface TextOutputSpec {
  readonly type: "text";
}

export interface ObjectOutputSpec<TSchema extends ZodTypeAny = ZodTypeAny> {
  readonly type: "object";
  readonly schema: TSchema;
  readonly name?: string;
  readonly description?: string;
  readonly mode?: StructuredOutputMode;
}

export type GenerateOutputSpec = TextOutputSpec | ObjectOutputSpec;

/**
 * Structured output for `generateText` and `streamText`. Tools may be passed
 * in the same call. `generateObject` remains available for the previous shape.
 */
export const Output = {
  text(): TextOutputSpec {
    return { type: "text" };
  },
  object<TSchema extends ZodTypeAny>(spec: {
    schema: TSchema;
    name?: string;
    description?: string;
    mode?: StructuredOutputMode;
  }): ObjectOutputSpec<TSchema> {
    if (!spec?.schema || isJsonSchema(spec.schema) || typeof spec.schema.safeParse !== "function") {
      throw new ValidationError("Output.object requires a Zod schema. Use jsonSchema() on tools.");
    }
    return {
      type: "object",
      schema: spec.schema,
      ...(spec.name !== undefined ? { name: spec.name } : {}),
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      ...(spec.mode !== undefined ? { mode: spec.mode } : {})
    };
  }
};

type OutputCarrier = GenerateTextOptions<LanguageModel, any> & { model: LanguageModel };

/** Apply `output` once, before the tool loop. Existing `structuredOutput` calls are unchanged. */
export const applyOutputSpec = <T extends OutputCarrier>(options: T): T => {
  const output = options.output as GenerateOutputSpec | undefined;
  if (!output) return options;
  if (output.type === "text") return options;
  if (options.structuredOutput) {
    throw new ValidationError('Pass either "output" or "structuredOutput", but not both.');
  }
  const requested = output.mode ?? "auto";
  const native = options.model.capabilities.structuredOutput === true;
  const objectMode = requested === "auto" ? (native ? "native" : "prompted") : requested;
  if (objectMode === "native" && !native) {
    throw new UnsupportedFeatureError("Model does not support native structured output.");
  }
  const next: T = { ...options };
  if (objectMode === "prompted") {
    const instruction = createStructuredOutputPrompt(output.schema, {
      name: output.name,
      description: output.description
    });
    if (options.messages !== undefined) {
      next.messages = [...options.messages, createTextMessage("system", instruction)];
    } else if (options.prompt !== undefined) {
      next.prompt = `${options.prompt}\n\n${instruction}`;
    } else {
      next.system = options.system ? `${options.system}\n\n${instruction}` : instruction;
    }
  } else {
    next.structuredOutput = {
      schema: output.schema,
      mode: "native",
      name: output.name,
      description: output.description
    };
  }
  return next;
};

export const readObjectOutput = (output: GenerateOutputSpec, text: string): unknown => {
  if (output.type !== "object") return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ParseError("Model response is not valid JSON.", { cause: error });
  }
  const result = output.schema.safeParse(parsed);
  if (!result.success) {
    throw new ValidationError(`Structured output validation failed: ${result.error.message}`);
  }
  return result.data;
};
