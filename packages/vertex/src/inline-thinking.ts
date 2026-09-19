import { ConfigurationError, type LanguageModel, type ModelGenerateInput, type ModelMessage, type StreamEvent } from "@zhivex-ai/core/provider";

const marker = "vertex_inline_thinking";
const opening = "<think>";
const closing = "</think>";

// Only MiniMax M2's documented leading envelope is interpreted. Tags later in
// the answer remain literal. Keep the exact envelope for subsequent tool turns.
const parser = () => {
  let pending = "", answer = false;
  const push = (text: string): StreamEvent[] => {
    if (answer) return text ? [{ type: "text-delta", textDelta: text }] : [];
    pending += text;
    const trimmed = pending.trimStart();
    if (opening.startsWith(trimmed)) {
      if (pending.length > 1024 * 1024) throw new ConfigurationError("Vertex MiniMax thinking envelope exceeded 1048576 characters.");
      return [];
    }
    if (!trimmed.startsWith(opening)) {
      answer = true;
      const textDelta = pending;
      pending = "";
      return [{ type: "text-delta", textDelta }];
    }
    const end = pending.indexOf(closing);
    if (end < 0) {
      if (pending.length > 1024 * 1024) throw new ConfigurationError("Vertex MiniMax thinking envelope exceeded 1048576 characters.");
      return [];
    }
    const split = end + closing.length;
    if (split > 1024 * 1024) throw new ConfigurationError("Vertex MiniMax thinking envelope exceeded 1048576 characters.");
    const events: StreamEvent[] = [{ type: "provider-data", provider: "vertex", data: { type: marker, content: pending.slice(0, split) } }];
    if (pending.slice(split)) events.push({ type: "text-delta", textDelta: pending.slice(split) });
    pending = "";
    answer = true;
    return events;
  };
  return {
    push,
    finish(): StreamEvent[] {
      if (pending.trimStart().startsWith(opening)) throw new ConfigurationError("Vertex MiniMax returned an incomplete thinking envelope.");
      const text = pending;
      pending = "";
      answer = true;
      return text ? [{ type: "text-delta", textDelta: text }] : [];
    }
  };
};

const restore = (input: ModelGenerateInput): ModelGenerateInput => ({
  ...input,
  messages: input.messages.map(message => message.role !== "assistant" ? message : {
    ...message,
    parts: message.parts.map(part => {
      if (part.type !== "provider-data" || part.provider !== "vertex" || !part.data || typeof part.data !== "object" || Array.isArray(part.data)) return part;
      const data = part.data as Record<string, unknown>;
      if (data.type !== marker) return part;
      if (typeof data.content !== "string") throw new ConfigurationError("Invalid Vertex inline thinking history.");
      return { type: "text" as const, text: data.content };
    })
  })
});

const normalizeParts = (parts: ModelMessage["parts"]): ModelMessage["parts"] => parts.flatMap<ModelMessage["parts"][number]>(part => {
  if (part.type !== "text") return [part];
  const state = parser();
  return [...state.push(part.text), ...state.finish()].map(event => {
    if (event.type === "text-delta") return { type: "text" as const, text: event.textDelta };
    return event as Extract<ModelMessage["parts"][number], { type: "provider-data" }>;
  });
});

export const normalizeVertexInlineThinking = (model: LanguageModel): LanguageModel => ({
  ...model,
  async generate(input) {
    const result = await model.generate(restore(input));
    const state = parser();
    const text = [...state.push(result.text ?? ""), ...state.finish()].map(event => event.type === "text-delta" ? event.textDelta : "").join("");
    return { ...result, text: result.text === undefined ? undefined : text, messages: result.messages?.map(message => message.role === "assistant" ? { ...message, parts: normalizeParts(message.parts) } : message) };
  },
  async stream(input) {
    if (!model.stream) throw new ConfigurationError("Vertex MiniMax stream transport is unavailable.");
    const stream = await model.stream(restore(input));
    return (async function* () {
      const state = parser();
      for await (const event of stream) {
        if (event.type === "text-delta") yield* state.push(event.textDelta);
        else {
          if (event.type === "finish") yield* state.finish();
          yield event;
        }
      }
      yield* state.finish();
    })();
  }
});
