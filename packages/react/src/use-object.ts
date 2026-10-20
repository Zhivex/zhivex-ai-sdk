"use client";

import { useCallback, useRef, useState } from "react";
import {
  applyObjectStreamEvent,
  createObjectStreamState,
  readServerSentEvents,
  type ObjectStreamState
} from "./object-stream.js";

export interface UseObjectOptions<T> {
  /** Endpoint that streams streamObject events as SSE. Defaults to /api/object. */
  api?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit;
  onPartial?: (object: Partial<T>) => void;
  onFinish?: (object: T) => void;
  onError?: (error: Error) => void;
}

export interface UseObjectResult<T> {
  /** Latest partial object, then the completed object. */
  object: Partial<T> | T | undefined;
  isLoading: boolean;
  error?: Error;
  submit: (body: unknown) => Promise<void>;
  stop: () => void;
  clear: () => void;
}

const isAbortError = (error: unknown): boolean =>
  (error instanceof DOMException && error.name === "AbortError") ||
  (error instanceof Error && error.name === "AbortError");

/**
 * Streams a structured object from an endpoint backed by streamObject
 * or Output.object text deltas. Partial objects update as events arrive.
 */
export const useObject = <T = unknown>(
  options: UseObjectOptions<T> = {}
): UseObjectResult<T> => {
  const [state, setState] = useState<ObjectStreamState<T>>(createObjectStreamState);
  const [isLoading, setIsLoading] = useState(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const abortRef = useRef<AbortController | undefined>(undefined);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = undefined;
    setIsLoading(false);
  }, []);

  const clear = useCallback(() => {
    stop();
    setState(createObjectStreamState());
  }, [stop]);

  const submit = useCallback(async (body: unknown) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);
    setState(createObjectStreamState());
    const current = optionsRef.current;
    try {
      const response = await (current.fetch ?? globalThis.fetch)(current.api ?? "/api/object", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...(current.headers ?? {})
        },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal
      });
      let next = createObjectStreamState<T>();
      for await (const event of readServerSentEvents(response)) {
        if (controller.signal.aborted) return;
        const previousObject = next.object;
        next = applyObjectStreamEvent(next, event);
        setState(next);
        if (next.object !== undefined && !next.done && next.object !== previousObject) {
          current.onPartial?.(next.object as Partial<T>);
        }
        if (next.error) {
          current.onError?.(next.error);
          break;
        }
        if (next.done && next.object !== undefined) {
          current.onFinish?.(next.object as T);
          break;
        }
      }
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) return;
      const streamError = error instanceof Error ? error : new Error(String(error));
      setState((previous) => ({ ...previous, done: true, error: streamError }));
      current.onError?.(streamError);
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = undefined;
        setIsLoading(false);
      }
    }
  }, []);

  return {
    object: state.object,
    isLoading,
    error: state.error,
    submit,
    stop,
    clear
  };
};
