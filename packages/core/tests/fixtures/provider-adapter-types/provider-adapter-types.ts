import { createProviderAdapter, type LanguageModel } from "@zhivex-ai/core";
import { createOpenAI } from "@zhivex-ai/openai";

type StrictProviderOptions = Record<string, unknown> & {
  mode?: "fast" | "accurate";
  top_p?: number;
};

declare const strictLanguageModel: LanguageModel<StrictProviderOptions>;

const strictProvider = createProviderAdapter({
  name: "strict",
  languageModel: (_modelId: string): LanguageModel<StrictProviderOptions> => strictLanguageModel
});

void strictProvider("strict-model").generate({
  messages: [],
  providerOptions: {
    mode: "fast",
    top_p: 0.8
  }
});

void strictProvider.languageModel("strict-model").generate({
  messages: [],
  providerOptions: {
    mode: "accurate",
    top_p: 0.7
  }
});

void strictProvider("strict-model").generate({
  messages: [],
  providerOptions: {
    // @ts-expect-error The callable adapter must retain its provider-specific model options.
    mode: "unsupported"
  }
});

void strictProvider.languageModel("strict-model").generate({
  messages: [],
  providerOptions: {
    // @ts-expect-error The languageModel method must retain its provider-specific model options.
    top_p: "0.7"
  }
});

const openai = createOpenAI({ apiKey: "test" });

void openai("gpt-test").generate({
  messages: [],
  providerOptions: {
    apiMode: "responses",
    top_p: 0.8
  }
});

void openai.languageModel("gpt-test").generate({
  messages: [],
  providerOptions: {
    apiMode: "chat",
    top_p: 0.7
  }
});

void openai("gpt-test").generate({
  messages: [],
  providerOptions: {
    // @ts-expect-error OpenAI top_p is numeric for callable provider access.
    top_p: "0.8"
  }
});

void openai.languageModel("gpt-test").generate({
  messages: [],
  providerOptions: {
    // @ts-expect-error OpenAI apiMode only accepts the modeled API modes.
    apiMode: "legacy"
  }
});
