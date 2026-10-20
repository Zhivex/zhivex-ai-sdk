import { parsePartialJson } from "./partial-json.js";

export interface ObjectStreamState<T> {
  text: string;
  object?: T;
  done: boolean;
  error?: Error;
}

export const createObjectStreamState = <T>(): ObjectStreamState<T> => ({
  text: "",
  done: false
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/**
 * Applies one streamObject / Output.object event.
 * object-partial and object-complete win over repaired text.
 * text-delta and object-delta repair incomplete JSON into a partial object.
 */
export const applyObjectStreamEvent = <T>(
  state: ObjectStreamState<T>,
  event: unknown
): ObjectStreamState<T> => {
  if (!isRecord(event) || typeof event.type !== "string") return state;
  if (event.type === "error") {
    const message = isRecord(event.error) && typeof event.error.message === "string"
      ? event.error.message
      : "Object stream failed.";
    return { ...state, done: true, error: new Error(message) };
  }
  if (event.type === "object-complete" && "object" in event) {
    return { ...state, object: event.object as T, done: true, error: undefined };
  }
  if (event.type === "object-partial" && "partialObject" in event) {
    return { ...state, object: event.partialObject as T, done: false };
  }
  if (event.type === "text-delta" && typeof event.textDelta === "string") {
    return applyText(state, state.text + event.textDelta);
  }
  if (event.type === "object-delta" && typeof event.partialText === "string") {
    return applyText(state, event.partialText);
  }
  if (event.type === "object-delta" && typeof event.textDelta === "string") {
    return applyText(state, state.text + event.textDelta);
  }
  return state;
};

const applyText = <T>(state: ObjectStreamState<T>, text: string): ObjectStreamState<T> => {
  const partial = parsePartialJson(text);
  if (partial === undefined || sameJson(partial, state.object)) {
    return { ...state, text };
  }
  return { ...state, text, object: partial as T };
};

export const readServerSentEvents = async function* (
  response: Response,
  limits: { maxEventChars?: number; maxEvents?: number } = {}
): AsyncGenerator<unknown> {
  if (!response.ok) {
    throw new Error(`Object request failed with status ${response.status}.`);
  }
  if (!response.body) {
    throw new Error("Object stream did not include a body.");
  }
  const maxEventChars = limits.maxEventChars ?? 1024 * 1024;
  const maxEvents = limits.maxEvents ?? 10_000;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let count = 0;
  let completed = false;
  const take = function* (rawEvent: string): Generator<unknown> {
    if (rawEvent.length > maxEventChars) {
      throw new Error(`Object stream event exceeded ${maxEventChars} characters.`);
    }
    const data = rawEvent
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data) return;
    count += 1;
    if (count > maxEvents) {
      throw new Error(`Object stream exceeded ${maxEvents} events.`);
    }
    yield JSON.parse(data) as unknown;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let separator = buffer.match(/\r?\n\r?\n/);
      while (separator) {
        const index = separator.index ?? 0;
        const rawEvent = buffer.slice(0, index);
        buffer = buffer.slice(index + separator[0].length);
        yield* take(rawEvent);
        separator = buffer.match(/\r?\n\r?\n/);
      }
      // A trailing delimiter can be split across reads. Three bytes cover a
      // partial "\r\n\r" without letting an unterminated event grow past the cap.
      if (buffer.length > maxEventChars + 3) {
        throw new Error(`Object stream event exceeded ${maxEventChars} characters.`);
      }
      if (done) {
        if (buffer.trim()) yield* take(buffer);
        completed = true;
        break;
      }
    }
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // Keep the overflow or parse error that stopped the read.
      }
    }
    reader.releaseLock();
  }
};
