import { UnsupportedFeatureError, ValidationError } from "./errors.js";
import { createTextMessage } from "./messages.js";
import type {
  GenerateGroundedTextOptions,
  GenerateGroundedTextOutput,
  GroundedLanguageModel,
  GroundedModelGenerateInput,
  ModelMessage
} from "./types.js";

const buildMessages = (options: Pick<GenerateGroundedTextOptions, "prompt" | "messages" | "system">): ModelMessage[] => {
  if (options.prompt !== undefined && options.messages !== undefined) {
    throw new ValidationError('Pass either "prompt" or "messages", but not both.');
  }

  const messages = [...(options.messages ?? [])];
  if (options.system) {
    messages.unshift(createTextMessage("system", options.system));
  }
  if (options.prompt) {
    messages.push(createTextMessage("user", options.prompt));
  }
  return messages;
};

export const generateGroundedText = async <TModel extends GroundedLanguageModel>(
  options: GenerateGroundedTextOptions<TModel>
): Promise<GenerateGroundedTextOutput> => {
  if (!options.model.capabilities.webSearch) {
    throw new UnsupportedFeatureError(
      `Model "${options.model.provider}/${options.model.modelId}" does not support web search.`
    );
  }

  const messages = buildMessages(options);
  const result = await options.model.generate({
    messages,
    system: options.system,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    reasoning: options.reasoning,
    providerOptions: options.providerOptions,
    abortSignal: options.abortSignal,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    retryBackoffMs: options.retryBackoffMs
  } as GroundedModelGenerateInput);

  return {
    ...result,
    messages
  };
};
