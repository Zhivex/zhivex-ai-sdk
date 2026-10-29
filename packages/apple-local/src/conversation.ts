import { toJSONSchema } from "zod";

import {
  UnsupportedFeatureError,
  ValidationError,
  isCallableToolDefinition,
  type JsonValue,
  type ModelGenerateInput,
  type ModelMessage,
  type ToolChoice
} from "@zhivex-ai/core/provider";

import type { AppleLocalLanguageModelOptions } from "./options.js";
import type {
  AppleLocalGenerateParams,
  AppleLocalImage,
  AppleLocalSampling,
  AppleLocalToolCallingMode,
  AppleLocalToolCall,
  AppleLocalToolSpec,
  AppleLocalTranscriptEntry,
  AppleLocalUseCase
} from "./protocol.js";
import { assertObjectSchema, convertJsonSchema } from "./schema.js";

const TOOL_INPUT_JSON_SCHEMA = Symbol.for("@zhivex-ai/core/json-schema");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toolInputSchema = (schema: unknown): Record<string, unknown> => {
  if (schema !== null && typeof schema === "object" && (schema as { [TOOL_INPUT_JSON_SCHEMA]?: unknown })[TOOL_INPUT_JSON_SCHEMA] === true) {
    return { ...(schema as { jsonSchema: Record<string, unknown> }).jsonSchema };
  }
  return toJSONSchema(schema as Parameters<typeof toJSONSchema>[0]) as Record<string, unknown>;
};

const textOf = (message: ModelMessage): string =>
  message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");

const decodeImage = (image: string, mediaType: string | undefined, path: string): AppleLocalImage => {
  const trimmed = image.trim();
  const dataUrl = /^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i.exec(trimmed);
  const declared = dataUrl?.[1] ?? mediaType;
  const data = (dataUrl?.[2] ?? trimmed).replace(/\s+/g, "");
  if (!declared || !declared.toLowerCase().startsWith("image/")) {
    throw new ValidationError(`${path} requires an image/* media type.`);
  }
  if (dataUrl === null && /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    throw new UnsupportedFeatureError(
      `${path} uses a URL. This bridge accepts image bytes. Apple documents file URLs and image objects inside the Swift process, not remote URLs.`
    );
  }
  if (!/^[a-z0-9+/]+={0,2}$/i.test(data) || data.length === 0 || data.length % 4 !== 0) {
    throw new ValidationError(`${path} is not valid base64 image data.`);
  }
  return { mediaType: declared, data };
};

const jsonArguments = (value: unknown, path: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new ValidationError(`${path} must be a JSON object. Apple tool arguments are a GenerationSchema object.`);
  }
  return value;
};

export const resolveUseCase = (modelId: string): AppleLocalUseCase => {
  switch (modelId) {
    case "apple-on-device":
    case "system":
    case "general":
      return "general";
    case "apple-on-device-content-tagging":
    case "content-tagging":
      return "contentTagging";
    default:
      throw new ValidationError(
        `Unknown Apple Local model "${modelId}". Documented ids are apple-on-device (SystemLanguageModel.default / use case general) and apple-on-device-content-tagging (use case contentTagging).`
      );
  }
};

const resolveToolCallingMode = (toolChoice: ToolChoice | undefined, toolCount: number): AppleLocalToolCallingMode | undefined => {
  if (toolCount === 0 || toolChoice === undefined || toolChoice === "auto") return toolCount === 0 ? undefined : "allowed";
  if (toolChoice === "none") return "disallowed";
  if (toolChoice === "required") return "required";
  throw new UnsupportedFeatureError(
    `Apple Local cannot force the specific tool "${toolChoice.toolName}". GenerationOptions.ToolCallingMode documents allowed, required, and disallowed only.`
  );
};

const resolveSampling = (
  input: ModelGenerateInput<AppleLocalLanguageModelOptions>
): AppleLocalSampling | undefined => {
  const explicit = input.providerOptions?.sampling;
  if (explicit && input.topP !== undefined) {
    throw new ValidationError("Set either topP or providerOptions.sampling, not both. topP maps to random(probabilityThreshold:).");
  }
  const seed = explicit && "seed" in explicit && explicit.seed !== undefined ? explicit.seed : input.seed;
  if (seed !== undefined && (!Number.isSafeInteger(seed) || seed < 0)) {
    throw new ValidationError("Apple's sampling seed is a UInt64. Provide a non-negative safe integer.");
  }
  if (!explicit) {
    if (input.topP !== undefined) {
      return { mode: "random", probabilityThreshold: input.topP, ...(seed !== undefined ? { seed } : {}) };
    }
    if (seed !== undefined) {
      throw new ValidationError(
        "Apple accepts a sampling seed only on random sampling (probabilityThreshold / topP, or a fixed top count). Set topP or providerOptions.sampling. The seed is best-effort."
      );
    }
    return undefined;
  }
  if (explicit.mode === "greedy") {
    if (seed !== undefined) {
      throw new ValidationError("GenerationOptions.SamplingMode.greedy does not take a seed. Use random sampling to pass one.");
    }
    return { mode: "greedy" };
  }
  if (explicit.mode === "random") {
    if (typeof explicit.probabilityThreshold !== "number" || explicit.probabilityThreshold < 0 || explicit.probabilityThreshold > 1) {
      throw new ValidationError("sampling.probabilityThreshold must be a number from 0 to 1, matching Apple's nucleus-sampling threshold.");
    }
    return {
      mode: "random",
      probabilityThreshold: explicit.probabilityThreshold,
      ...(seed !== undefined ? { seed } : {})
    };
  }
  if (!Number.isSafeInteger(explicit.top) || explicit.top < 1) {
    throw new ValidationError("sampling.top must be a positive integer, matching random(top:).");
  }
  return { mode: "top", top: explicit.top, ...(seed !== undefined ? { seed } : {}) };
};

const assertKnownOptions = (options: AppleLocalLanguageModelOptions | undefined) => {
  if (!options) return;
  for (const key of Object.keys(options)) {
    if (!["guardrails", "sampling", "includeSchemaInPrompt", "locale"].includes(key)) {
      throw new ValidationError(
        `Unknown Apple Local provider option "${key}". Documented options are guardrails, sampling, includeSchemaInPrompt, and locale.`
      );
    }
  }
  if (options.guardrails !== undefined && options.guardrails !== "permissiveContentTransformations") {
    throw new ValidationError(
      'guardrails must be "permissiveContentTransformations". Omit it to keep SystemLanguageModel\'s default guardrails.'
    );
  }
  if (options.locale !== undefined && (typeof options.locale !== "string" || options.locale.trim() === "")) {
    throw new ValidationError("locale must be a non-empty BCP-47 string passed to supportsLocale.");
  }
  if (options.includeSchemaInPrompt !== undefined && typeof options.includeSchemaInPrompt !== "boolean") {
    throw new ValidationError("includeSchemaInPrompt must be a boolean.");
  }
};

export const buildGenerateParams = (
  modelId: string,
  useCase: AppleLocalUseCase,
  input: ModelGenerateInput<AppleLocalLanguageModelOptions>
): AppleLocalGenerateParams => {
  assertKnownOptions(input.providerOptions);
  if (input.reasoning) {
    throw new UnsupportedFeatureError(
      `Model "apple-local/${modelId}" does not support reasoning. reasoningLevel is documented on Private Cloud Compute, which this on-device provider does not call.`
    );
  }
  if (input.temperature !== undefined && (typeof input.temperature !== "number" || !Number.isFinite(input.temperature))) {
    throw new ValidationError("temperature must be a finite number. Apple does not document a fixed range; the bridge forwards the value.");
  }
  if (input.maxTokens !== undefined && (!Number.isSafeInteger(input.maxTokens) || input.maxTokens < 1)) {
    throw new ValidationError("maxTokens must be a positive integer. It maps to GenerationOptions.maximumResponseTokens.");
  }

  const instructions: string[] = [];
  const transcript: AppleLocalTranscriptEntry[] = [];
  const pendingCalls = new Map<string, string>();
  let activePrompt: { text: string; images: AppleLocalImage[] } | undefined;
  let sawConversation = false;
  let entryIndex = 0;
  const nextId = (prefix: string) => `${prefix}-${entryIndex++}`;

  const flushPrompt = () => {
    if (!activePrompt) return;
    transcript.push({ type: "prompt", id: nextId("prompt"), text: activePrompt.text });
    if (activePrompt.images.length > 0) {
      throw new UnsupportedFeatureError(
        "Image parts must be on the latest user message. This bridge attaches images to the prompt passed to respond, not to earlier transcript prompts."
      );
    }
    activePrompt = undefined;
  };

  for (const [messageIndex, message] of input.messages.entries()) {
    const path = `messages[${messageIndex}]`;
    for (const [partIndex, part] of message.parts.entries()) {
      const partPath = `${path}.parts[${partIndex}]`;
      if (part.type === "file" || part.type === "audio") {
        throw new UnsupportedFeatureError(`Model "apple-local/${modelId}" does not support ${part.type} inputs.`);
      }
      if (part.type === "provider-data") {
        throw new UnsupportedFeatureError(
          "Apple Local does not accept provider-data parts. Refusing them avoids dropping reasoning or provider state silently."
        );
      }
      if (part.type === "image" && message.role !== "user") {
        throw new UnsupportedFeatureError("Apple Local accepts image parts only on user messages.");
      }
    }

    if (message.role === "system") {
      if (sawConversation) {
        throw new ValidationError(
          "System instructions must come before the conversation. LanguageModelSession applies Instructions to the whole session."
        );
      }
      if (message.parts.some((part) => part.type !== "text")) {
        throw new UnsupportedFeatureError("System messages for Apple Local can only contain text instructions.");
      }
      const text = textOf(message).trim();
      if (text) instructions.push(text);
      continue;
    }
    sawConversation = true;

    if (message.role === "user") {
      flushPrompt();
      const images = message.parts.flatMap((part, partIndex) =>
        part.type === "image" ? [decodeImage(part.image, part.mediaType, `${path}.parts[${partIndex}]`)] : []
      );
      activePrompt = { text: textOf(message), images };
      continue;
    }

    if (message.role === "assistant") {
      flushPrompt();
      const text = textOf(message);
      if (text) transcript.push({ type: "response", id: nextId("response"), text });
      const calls: AppleLocalToolCall[] = [];
      for (const [partIndex, part] of message.parts.entries()) {
        if (part.type !== "tool-call") continue;
        calls.push({
          id: part.toolCall.id,
          name: part.toolCall.name,
          arguments: jsonArguments(part.toolCall.input, `${path}.parts[${partIndex}].toolCall.input`)
        });
        pendingCalls.set(part.toolCall.id, part.toolCall.name);
      }
      if (calls.length > 0) transcript.push({ type: "toolCalls", id: nextId("tool-calls"), calls });
      for (const [partIndex, part] of message.parts.entries()) {
        if (part.type !== "tool-result") continue;
        const expected = pendingCalls.get(part.toolResult.toolCallId);
        if (!expected) {
          throw new ValidationError(`${path}.parts[${partIndex}] has a tool result without a matching tool call.`);
        }
        transcript.push({
          type: "toolOutput",
          id: part.toolResult.toolCallId,
          name: part.toolResult.toolName || expected,
          output: toolOutputText(part.toolResult)
        });
        pendingCalls.delete(part.toolResult.toolCallId);
      }
      continue;
    }

    flushPrompt();
    for (const [partIndex, part] of message.parts.entries()) {
      if (part.type !== "tool-result") {
        throw new UnsupportedFeatureError(`Tool messages can only contain tool results (${path}.parts[${partIndex}] is ${part.type}).`);
      }
      const expected = pendingCalls.get(part.toolResult.toolCallId);
      if (!expected) {
        throw new ValidationError(`${path}.parts[${partIndex}] has a tool result without a matching tool call.`);
      }
      transcript.push({
        type: "toolOutput",
        id: part.toolResult.toolCallId,
        name: part.toolResult.toolName || expected,
        output: toolOutputText(part.toolResult)
      });
      pendingCalls.delete(part.toolResult.toolCallId);
    }
  }

  if (pendingCalls.size > 0) {
    throw new ValidationError("Apple Local history has tool calls without tool results. Send the results before the next turn.");
  }

  const continuation = activePrompt === undefined && transcript.some((entry) => entry.type === "toolOutput");
  const prompt = activePrompt ?? (continuation ? { text: "", images: [] as AppleLocalImage[] } : undefined);
  if (!prompt) {
    throw new ValidationError(
      "Apple Local requires a user prompt or a tool-result continuation. SystemLanguageModel sessions start with respond(to:)."
    );
  }

  const tools = collectTools(input);
  const sampling = resolveSampling(input);
  const guardrails = input.providerOptions?.guardrails;
  const schema = input.structuredOutput && input.structuredOutput.mode !== "prompted"
    ? convertJsonSchema(toolInputSchema(input.structuredOutput.schema), "structuredOutput")
    : undefined;
  if (guardrails === "permissiveContentTransformations" && schema) {
    throw new UnsupportedFeatureError(
      "permissiveContentTransformations is documented only for string generation. Guided generation keeps the default guardrails."
    );
  }

  const images = prompt.images;
  return {
    modelId,
    useCase,
    ...(guardrails ? { guardrails } : {}),
    ...(input.providerOptions?.locale ? { locale: input.providerOptions.locale } : {}),
    ...(instructions.length > 0 ? { instructions: instructions.join("\n\n") } : {}),
    transcript,
    prompt: { text: prompt.text, ...(images.length > 0 ? { images } : {}) },
    ...(continuation ? { continuation: true } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(resolveToolCallingMode(input.toolChoice, tools.length)
      ? { toolCallingMode: resolveToolCallingMode(input.toolChoice, tools.length) }
      : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.maxTokens !== undefined ? { maximumResponseTokens: input.maxTokens } : {}),
    ...(sampling ? { sampling } : {}),
    ...(schema ? { responseSchema: schema } : {}),
    ...(schema && input.providerOptions?.includeSchemaInPrompt ? { includeSchemaInPrompt: true } : {})
  };
};

const toolOutputText = (result: { output?: JsonValue; error?: { message: string }; isError: boolean }): string => {
  if (result.isError) return result.error?.message ?? "";
  if (typeof result.output === "string") return result.output;
  if (result.output === undefined) return "";
  return JSON.stringify(result.output);
};

const collectTools = (input: ModelGenerateInput<AppleLocalLanguageModelOptions>): AppleLocalToolSpec[] => {
  if (!input.tools) return [];
  const specs: AppleLocalToolSpec[] = [];
  for (const [name, definition] of Object.entries(input.tools)) {
    if (!isCallableToolDefinition(definition)) {
      throw new UnsupportedFeatureError(
        `Apple Local does not support hosted tool "${name}". The on-device provider only forwards callable tools to the Swift Tool protocol.`
      );
    }
    const parameters = convertJsonSchema(toolInputSchema(definition.schema), `tools.${definition.name}.schema`);
    assertObjectSchema(parameters, `tools.${definition.name}.schema`);
    specs.push({
      name: definition.name,
      description: definition.description ?? definition.name,
      parameters
    });
  }
  return specs;
};
