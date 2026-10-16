import { withTimeoutSignal } from "./runtime.js";
import { streamSSE } from "./stream.js";
import type { ModelMessage, StreamEvent } from "./types.js";

/** Bearer JSON headers shared by OpenAI-compatible chat adapters. */
export const openAICompatibleJsonHeaders = (apiKey: string): Record<string, string> => ({
  "content-type": "application/json",
  authorization: `Bearer ${apiKey}`
});

/** Read provider-scoped reasoning text preserved as provider-data parts. */
export const openAICompatibleReasoningContent = (message: ModelMessage, provider: string): string =>
  message.parts
    .filter((part) => {
      if (part.type !== "provider-data" || part.provider !== provider || !part.data || typeof part.data !== "object") {
        return false;
      }
      const data = part.data as Record<string, unknown>;
      return data.type === "reasoning_content" && typeof data.reasoningContent === "string";
    })
    .map((part) => (part.type === "provider-data" ? String((part.data as Record<string, unknown>).reasoningContent) : ""))
    .join("");

export interface OpenAICompatibleToolCallBuffer {
  id: string;
  name: string;
  args: string;
}

export interface OpenAICompatibleStreamState {
  finishReason?: string;
  usage: unknown;
  finishEmitted: boolean;
}

/**
 * Provider-owned chunk handling on top of one SSE loop. Adapters keep their
 * own tool, usage, and finish rules so the shared transport does not change
 * those results.
 */
export interface OpenAICompatibleStreamProfile {
  readPayload: (data: string) => unknown;
  onChunk: (
    payload: any,
    tools: Map<number, OpenAICompatibleToolCallBuffer>,
    state: OpenAICompatibleStreamState
  ) => Iterable<StreamEvent>;
  onDone: (
    tools: Map<number, OpenAICompatibleToolCallBuffer>,
    state: OpenAICompatibleStreamState
  ) => Iterable<StreamEvent>;
}

export async function* streamOpenAICompatibleChat(
  response: Response,
  profile: OpenAICompatibleStreamProfile
): AsyncGenerator<StreamEvent> {
  const tools = new Map<number, OpenAICompatibleToolCallBuffer>();
  const state: OpenAICompatibleStreamState = { usage: undefined, finishEmitted: false };
  for await (const event of streamSSE(response)) {
    if (event.data === "[DONE]") break;
    yield* profile.onChunk(profile.readPayload(event.data), tools, state);
  }
  yield* profile.onDone(tools, state);
}

/** Apply the caller's timeout around one non-streaming attempt and always release it. */
export const withOpenAICompatibleAttempt = async <T>(
  input: { abortSignal?: AbortSignal; timeoutMs?: number },
  operation: (signal: AbortSignal | undefined) => Promise<T>,
  normalizeError?: (error: unknown) => unknown
): Promise<T> => {
  const { signal, cleanup } = withTimeoutSignal(input);
  try {
    return await operation(signal);
  } catch (error) {
    if (!normalizeError) throw error;
    throw normalizeError(error);
  } finally {
    cleanup();
  }
};

/** Open a streaming response, then adapt its SSE body with the provider profile. */
export const openOpenAICompatibleStream = async (
  input: { abortSignal?: AbortSignal; timeoutMs?: number },
  open: (signal: AbortSignal | undefined) => Promise<Response>,
  profile: OpenAICompatibleStreamProfile,
  normalizeError?: (error: unknown) => unknown
): Promise<AsyncIterable<StreamEvent>> => {
  const { signal, cleanup } = withTimeoutSignal(input);
  let response: Response;
  try {
    response = await open(signal);
  } catch (error) {
    cleanup();
    if (!normalizeError) throw error;
    throw normalizeError(error);
  }
  return (async function* () {
    try {
      yield* streamOpenAICompatibleChat(response, profile);
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    } finally {
      cleanup();
    }
  })();
};

/** Same timeout boundary for adapters whose stream is not Chat Completions SSE. */
export const openOpenAICompatibleEvents = async (
  input: { abortSignal?: AbortSignal; timeoutMs?: number },
  open: (signal: AbortSignal | undefined) => Promise<AsyncIterable<StreamEvent>>,
  normalizeError?: (error: unknown) => unknown
): Promise<AsyncIterable<StreamEvent>> => {
  const { signal, cleanup } = withTimeoutSignal(input);
  try {
    const events = await open(signal);
    return (async function* () {
      try {
        yield* events;
      } finally {
        cleanup();
      }
    })();
  } catch (error) {
    cleanup();
    if (!normalizeError) throw error;
    throw normalizeError(error);
  }
};
