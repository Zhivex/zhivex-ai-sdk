import type { ZodTypeAny } from "zod";

import { BoundedReplayBroadcast } from "./bounded-broadcast.js";
import { ParseError, UnsupportedFeatureError, ValidationError } from "./errors.js";
import { createTextMessage } from "./messages.js";
import { generateText, streamText } from "./generate-text.js";
import { resolveLanguageModel } from "./model-registry.js";
import { createStructuredOutputPrompt } from "./structured-output-prompt.js";
import type {
  GenerateObjectOptions,
  GenerateObjectOutput,
  GenerateTextOptions,
  LanguageModel,
  ModelMessage,
  ObjectStreamEvent,
  StreamObjectResult,
  StructuredOutputMode
} from "./types.js";

type StructuredPromptConfig =
  | { messages: ModelMessage[] }
  | { prompt: string }
  | {};

const resolveObjectMode = (requestedMode: StructuredOutputMode, nativeAllowed: boolean): Exclude<StructuredOutputMode, "auto"> => {
  const objectMode = requestedMode === "auto" ? (nativeAllowed ? "native" : "prompted") : requestedMode;

  if (objectMode === "native" && !nativeAllowed) {
    throw new UnsupportedFeatureError(
      "Model does not support native structured output."
    );
  }

  return objectMode;
};

const withStructuredPrompt = <TSchema extends ZodTypeAny>(
  options: GenerateObjectOptions<TSchema>,
  objectMode: Exclude<StructuredOutputMode, "auto">
): StructuredPromptConfig => {
  if (objectMode !== "prompted") {
    if (options.messages !== undefined) {
      return { messages: options.messages };
    }
    if (options.prompt !== undefined) {
      return { prompt: options.prompt };
    }
    return {};
  }

  const instruction = createStructuredOutputPrompt(options.schema, {
    name: options.schemaName,
    description: options.schemaDescription
  });
  if (options.messages !== undefined) {
    return {
      messages: [...options.messages, createTextMessage("system", instruction)]
    };
  }
  if (options.prompt !== undefined) {
    return {
      prompt: `${options.prompt}\n\n${instruction}`
    };
  }
  return {};
};

const parseObject = <TSchema extends ZodTypeAny>(
  text: string,
  schema: TSchema
): GenerateObjectOutput<TSchema>["object"] => {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (error) {
    throw new ParseError("Model response is not valid JSON.", { cause: error });
  }

  const parsed = schema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new ValidationError(`Structured output validation failed: ${parsed.error.message}`);
  }

  return parsed.data;
};

// Keep lexical repair state between deltas; completed prefixes need not be rescanned.
const createPartialObjectParser = () => {
  const closers: string[] = [];
  let inString = false;
  let isEscaped = false;
  let lastToken: "value" | "colon" | "comma" | "other" = "other";
  let start = -1;
  let scanned = 0;
  return (text: string): unknown | undefined => {
    if (start === -1) {
      const offset = text.slice(scanned).search(/[{\[]/);
      if (offset === -1) {
        scanned = text.length;
        return undefined;
      }
      start = scanned + offset;
      scanned = start;
    }
    for (const char of text.slice(scanned)) {
      if (inString) {
        if (isEscaped) {
          isEscaped = false;
          continue;
        }

        if (char === "\\") {
          isEscaped = true;
          continue;
        }

        if (char === "\"") {
          inString = false;
          lastToken = "value";
        }

        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === "{") {
        closers.push("}");
        lastToken = "other";
        continue;
      }

      if (char === "[") {
        closers.push("]");
        lastToken = "other";
        continue;
      }

      if (char === "}" || char === "]") {
        if (closers.at(-1) === char) {
          closers.pop();
        }
        lastToken = "value";
        continue;
      }

      if (char === ":") {
        lastToken = "colon";
        continue;
      }

      if (char === ",") {
        lastToken = "comma";
        continue;
      }

      if (/\S/.test(char)) {
        lastToken = "value";
      }
    }

    scanned = text.length;
    let repaired = text.slice(start).trim();

    if (inString) {
      repaired += "\"";
    }

    if (lastToken === "colon") {
      repaired += " null";
    }

    if (lastToken === "comma") {
      repaired = repaired.replace(/,\s*$/, "");
    }

    try {
      return JSON.parse(repaired + [...closers].reverse().join(""));
    } catch {
      return undefined;
    }
  };
};

const getStructuredOutput = <TSchema extends ZodTypeAny>(
  options: GenerateObjectOptions<TSchema>,
  objectMode: Exclude<StructuredOutputMode, "auto">
) =>
  objectMode === "native"
    ? {
        schema: options.schema,
        mode: "native" as const,
        name: options.schemaName,
        description: options.schemaDescription
      }
    : undefined;

const createObjectOptions = <TSchema extends ZodTypeAny>(
  options: Omit<GenerateObjectOptions<TSchema>, "model"> & { model: LanguageModel }
) => {
  const requestedMode = options.mode ?? "auto";
  const objectMode = resolveObjectMode(requestedMode, options.model.capabilities.structuredOutput);
  const source = options as GenerateObjectOptions<TSchema>;
  const promptConfig = withStructuredPrompt(source, objectMode);
  const structuredOutput = getStructuredOutput(source, objectMode);
  // Preserve policies, hooks, tool context and retry controls from GenerateTextOptions.
  const {
    schema: _schema, mode: _mode, schemaName: _name, schemaDescription: _description,
    snapshotIntervalChars: _snapshotInterval,
    prompt: _prompt, messages: _messages, ...requestBase
  } = options;

  let request: GenerateTextOptions;
  if ("messages" in promptConfig) {
    request = {
      ...requestBase,
      messages: promptConfig.messages,
      structuredOutput
    };
  } else if ("prompt" in promptConfig) {
    request = {
      ...requestBase,
      prompt: promptConfig.prompt,
      structuredOutput
    };
  } else {
    request = {
      ...requestBase,
      structuredOutput
    };
  }

  return {
    objectMode,
    request
  };
};

const withResolvedModel = <TSchema extends ZodTypeAny>(
  options: GenerateObjectOptions<TSchema>
): GenerateObjectOptions<TSchema> & { model: LanguageModel } => ({
  ...options,
  model: resolveLanguageModel(options.model, options.modelResolver)
});

export const generateObject = async <TSchema extends ZodTypeAny>(
  options: GenerateObjectOptions<TSchema>
): Promise<GenerateObjectOutput<TSchema>> => {
  const { objectMode, request } = createObjectOptions(withResolvedModel(options));
  const textResult = await generateText(request);
  const object = parseObject(textResult.text, options.schema);

  return {
    ...textResult,
    object,
    objectMode
  };
};

export const streamObject = <TSchema extends ZodTypeAny>(options: GenerateObjectOptions<TSchema>): StreamObjectResult<TSchema> => {
  const snapshotInterval = options.snapshotIntervalChars ?? 1;
  if (!Number.isSafeInteger(snapshotInterval) || snapshotInterval < 1) {
    throw new ValidationError('snapshotIntervalChars must be a positive safe integer.');
  }
  const { objectMode, request } = createObjectOptions(withResolvedModel(options));
  const streamResult = streamText(request);

  type ObjectEvent = ObjectStreamEvent<
    GenerateObjectOutput<TSchema>["object"],
    Partial<GenerateObjectOutput<TSchema>["object"]>
  >;
  type PartialObject = Partial<GenerateObjectOutput<TSchema>["object"]>;
  const broadcast = new BoundedReplayBroadcast<ObjectEvent>(options.streamBuffer);
  const partialBroadcast = new BoundedReplayBroadcast<PartialObject>(options.streamBuffer);

  const createEventStream = () => broadcast.stream();
  const createPartialStream = () => partialBroadcast.stream();

  const finalResultPromise = (async () => {
    let text = "";
    let lastPartialJson: string | undefined;
    const parsePartialObject = createPartialObjectParser();
    let pendingDelta = "";
    const publishSnapshot = async () => {
      await broadcast.publish({ type: "object-delta", textDelta: pendingDelta, partialText: text });
      pendingDelta = "";
      const partial = parsePartialObject(text) as PartialObject | undefined;
      if (partial !== undefined) {
        const serialized = JSON.stringify(partial);
        if (serialized !== lastPartialJson) {
          lastPartialJson = serialized;
          await broadcast.publish({ type: "object-partial", partialObject: partial });
          await partialBroadcast.publish(partial);
        }
      }
    };

    for await (const event of streamResult.eventStream) {
      await broadcast.publish(event);

      if (event.type !== "text-delta") {
        continue;
      }

      text += event.textDelta;
      pendingDelta += event.textDelta;
      if (pendingDelta.length >= snapshotInterval || (snapshotInterval === 1 && !event.textDelta)) {
        await publishSnapshot();
      }
    }
    if (pendingDelta) await publishSnapshot();

    const textResult = await streamResult.collect();
    const object = parseObject(textResult.text, options.schema);

    await broadcast.publish({ type: "object-complete", object }, { terminal: true });

    broadcast.close();
    partialBroadcast.close();

    return {
      ...textResult,
      object,
      objectMode
    };
  })().catch(async (error) => {
    const streamError = error instanceof Error ? error : new Error(String(error));
    if (streamError.name === "StreamBufferOverflowError") {
      broadcast.fail(streamError);
      partialBroadcast.fail(streamError);
    } else {
      await broadcast.publish({ type: "error", error: streamError }, { terminal: true });
      broadcast.close();
      partialBroadcast.close();
    }
    throw error;
  });
  void finalResultPromise.catch(() => {});

  return {
    cancel: streamResult.cancel,
    eventStream: createEventStream(),
    partialObjectStream: createPartialStream(),
    textStream: streamResult.textStream,
    collect: async () => finalResultPromise
  };
};
