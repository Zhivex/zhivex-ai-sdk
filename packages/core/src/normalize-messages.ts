import { ValidationError } from "./errors.js";
import { createTextMessage } from "./messages.js";
import type { GenerateTextOptions, ModelMessage } from "./types.js";

export const normalizeMessages = (options: Pick<GenerateTextOptions<any, any>, "prompt" | "messages" | "system">): ModelMessage[] => {
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

