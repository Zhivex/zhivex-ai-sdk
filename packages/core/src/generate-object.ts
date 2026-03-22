import type { ZodTypeAny } from "zod";

import { ParseError, UnsupportedFeatureError, ValidationError } from "./errors.js";
import { createTextMessage } from "./messages.js";
import { generateText, streamText } from "./generate-text.js";
import type {
  GenerateObjectOptions,
  GenerateObjectOutput,
  GenerateTextOptions,
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

  if (options.messages !== undefined) {
    return {
      messages: [...options.messages, createTextMessage("system", "Return only valid JSON matching the requested schema.")]
    };
  }
  if (options.prompt !== undefined) {
    return {
      prompt: `${options.prompt}\n\nReturn only valid JSON matching the requested schema.`
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

const repairPartialJson = (text: string): string | undefined => {
  const start = text.search(/[{\[]/);
  if (start === -1) {
    return undefined;
  }

  const slice = text.slice(start).trim();
  if (!slice) {
    return undefined;
  }

  const closers: string[] = [];
  let inString = false;
  let isEscaped = false;
  let lastToken: "value" | "colon" | "comma" | "other" = "other";

  for (const char of slice) {
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

  let repaired = slice.trimEnd();

  if (inString) {
    repaired += "\"";
  }

  if (lastToken === "colon") {
    repaired += " null";
  }

  if (lastToken === "comma") {
    repaired = repaired.replace(/,\s*$/, "");
  }

  return repaired + [...closers].reverse().join("");
};

const parsePartialObject = (text: string): unknown | undefined => {
  const repaired = repairPartialJson(text);
  if (!repaired) {
    return undefined;
  }

  try {
    return JSON.parse(repaired);
  } catch {
    return undefined;
  }
};

const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

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

const createObjectOptions = <TSchema extends ZodTypeAny>(options: GenerateObjectOptions<TSchema>) => {
  const requestedMode = options.mode ?? "auto";
  const objectMode = resolveObjectMode(requestedMode, options.model.capabilities.structuredOutput);
  const promptConfig = withStructuredPrompt(options, objectMode);
  const structuredOutput = getStructuredOutput(options, objectMode);
  const requestBase = {
    model: options.model,
    system: options.system,
    tools: options.tools,
    maxSteps: options.maxSteps,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    providerOptions: options.providerOptions,
    abortSignal: options.abortSignal,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    retryBackoffMs: options.retryBackoffMs
  };

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

export const generateObject = async <TSchema extends ZodTypeAny>(
  options: GenerateObjectOptions<TSchema>
): Promise<GenerateObjectOutput<TSchema>> => {
  const { objectMode, request } = createObjectOptions(options);
  const textResult = await generateText(request);
  const object = parseObject(textResult.text, options.schema);

  return {
    ...textResult,
    object,
    objectMode
  };
};

export const streamObject = <TSchema extends ZodTypeAny>(options: GenerateObjectOptions<TSchema>): StreamObjectResult<TSchema> => {
  const { objectMode, request } = createObjectOptions(options);
  const streamResult = streamText(request);

  const subscribers = new Set<(value: IteratorResult<ObjectStreamEvent<GenerateObjectOutput<TSchema>["object"], Partial<GenerateObjectOutput<TSchema>["object"]>>>) => void>();
  const partialSubscribers = new Set<(value: IteratorResult<Partial<GenerateObjectOutput<TSchema>["object"]>>) => void>();
  const history: IteratorResult<ObjectStreamEvent<GenerateObjectOutput<TSchema>["object"], Partial<GenerateObjectOutput<TSchema>["object"]>>>[] = [];
  const partialHistory: IteratorResult<Partial<GenerateObjectOutput<TSchema>["object"]>>[] = [];
  let done = false;
  let partialDone = false;

  const publish = (
    value: IteratorResult<ObjectStreamEvent<GenerateObjectOutput<TSchema>["object"], Partial<GenerateObjectOutput<TSchema>["object"]>>>
  ) => {
    history.push(value);
    for (const subscriber of subscribers) {
      subscriber(value);
    }
    if (value.done) {
      done = true;
    }
  };

  const publishPartial = (value: IteratorResult<Partial<GenerateObjectOutput<TSchema>["object"]>>) => {
    partialHistory.push(value);
    for (const subscriber of partialSubscribers) {
      subscriber(value);
    }
    if (value.done) {
      partialDone = true;
    }
  };

  const createEventStream = async function* () {
    let cursor = 0;

    while (true) {
      while (cursor < history.length) {
        const item = history[cursor];
        cursor += 1;
        if (item.done) {
          return;
        }
        yield item.value;
      }

      if (done) {
        return;
      }

      await new Promise<
        IteratorResult<ObjectStreamEvent<GenerateObjectOutput<TSchema>["object"], Partial<GenerateObjectOutput<TSchema>["object"]>>>
      >((resolve) => {
        const subscriber = (
          value: IteratorResult<ObjectStreamEvent<GenerateObjectOutput<TSchema>["object"], Partial<GenerateObjectOutput<TSchema>["object"]>>>
        ) => {
          subscribers.delete(subscriber);
          resolve(value);
        };
        subscribers.add(subscriber);
      });
    }
  };

  const createPartialStream = async function* () {
    let cursor = 0;

    while (true) {
      while (cursor < partialHistory.length) {
        const item = partialHistory[cursor];
        cursor += 1;
        if (item.done) {
          return;
        }
        yield item.value;
      }

      if (partialDone) {
        return;
      }

      await new Promise<IteratorResult<Partial<GenerateObjectOutput<TSchema>["object"]>>>((resolve) => {
        const subscriber = (value: IteratorResult<Partial<GenerateObjectOutput<TSchema>["object"]>>) => {
          partialSubscribers.delete(subscriber);
          resolve(value);
        };
        partialSubscribers.add(subscriber);
      });
    }
  };

  const finalResultPromise = (async () => {
    let text = "";
    let lastPartial: Partial<GenerateObjectOutput<TSchema>["object"]> | undefined;
    let completed = false;

    for await (const event of streamResult.eventStream) {
      publish({ done: false, value: event });

      if (event.type !== "text-delta") {
        continue;
      }

      text += event.textDelta;
      publish({
        done: false,
        value: {
          type: "object-delta",
          textDelta: event.textDelta,
          partialText: text
        }
      });

      const partial = parsePartialObject(text) as Partial<GenerateObjectOutput<TSchema>["object"]> | undefined;
      if (partial !== undefined && !sameJson(partial, lastPartial)) {
        lastPartial = partial;
        publish({ done: false, value: { type: "object-partial", partialObject: partial } });
        publishPartial({ done: false, value: partial });

        if (!completed) {
          const parsed = options.schema.safeParse(partial);
          if (parsed.success) {
            completed = true;
            publish({ done: false, value: { type: "object-complete", object: parsed.data } });
          }
        }
      }
    }

    const textResult = await streamResult.collect();
    const object = parseObject(textResult.text, options.schema);

    if (!completed) {
      publish({ done: false, value: { type: "object-complete", object } });
    }

    publish({ done: true, value: undefined });
    publishPartial({ done: true, value: undefined });

    return {
      ...textResult,
      object,
      objectMode
    };
  })().catch((error) => {
    const streamError = error instanceof Error ? error : new Error(String(error));
    publish({ done: false, value: { type: "error", error: streamError } });
    publish({ done: true, value: undefined });
    publishPartial({ done: true, value: undefined });
    throw error;
  });

  return {
    eventStream: createEventStream(),
    partialObjectStream: createPartialStream(),
    textStream: streamResult.textStream,
    collect: async () => finalResultPromise
  };
};
