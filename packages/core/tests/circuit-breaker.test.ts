import { describe, expect, it } from "vitest";

import {
  createCircuitBreakerMiddleware,
  createTextMessage,
  wrapLanguageModel
} from "../src/index.js";
import type { LanguageModel, StreamEvent } from "../src/index.js";

const capabilities: LanguageModel["capabilities"] = {
  streaming: true,
  tools: false,
  structuredOutput: false,
  jsonMode: false,
  toolChoice: false,
  parallelToolCalls: false,
  vision: false,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
  reasoning: false,
  webSearch: false
};

const input = { messages: [createTextMessage("user", "hello")] };

describe("circuit breaker middleware", () => {
  it("validates thresholds and cooldowns", () => {
    expect(() => createCircuitBreakerMiddleware({ failureThreshold: 0 })).toThrow(
      "failureThreshold"
    );
    expect(() => createCircuitBreakerMiddleware({ cooldownMs: -1 })).toThrow(
      "cooldownMs"
    );
  });

  it("allows only one half-open probe and closes after it succeeds", async () => {
    const states: string[] = [];
    let attempts = 0;
    let resolveProbe!: () => void;
    const probe = new Promise<void>((resolve) => {
      resolveProbe = resolve;
    });
    const model: LanguageModel = {
      provider: "test",
      modelId: "half-open",
      capabilities,
      async generate() {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("initial failure");
        }
        await probe;
        return { text: "recovered" };
      }
    };
    const wrapped = wrapLanguageModel(model, [
      createCircuitBreakerMiddleware({
        failureThreshold: 1,
        cooldownMs: 0,
        onStateChange(state) {
          states.push(state.status);
        }
      })
    ]);

    await expect(wrapped.generate(input)).rejects.toThrow("initial failure");
    const halfOpenRequest = wrapped.generate(input);
    await expect(wrapped.generate(input)).rejects.toThrow("Circuit breaker open");
    resolveProbe();
    await expect(halfOpenRequest).resolves.toMatchObject({ text: "recovered" });
    await expect(wrapped.generate(input)).resolves.toMatchObject({ text: "recovered" });

    expect(states).toEqual(["open", "half-open", "closed"]);
  });

  it("closes a half-open circuit when the probe error is not a circuit failure", async () => {
    const states: string[] = [];
    let attempts = 0;
    const wrapped = wrapLanguageModel({
      provider: "test",
      modelId: "non-failure-probe",
      capabilities,
      async generate() {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("503 upstream unavailable");
        }
        if (attempts === 2) {
          throw new Error("400 invalid request");
        }
        return { text: "reachable" };
      }
    }, [createCircuitBreakerMiddleware({
      failureThreshold: 1,
      cooldownMs: 0,
      isFailure(error) {
        return error.message.startsWith("503");
      },
      onStateChange(state) {
        states.push(state.status);
      }
    })]);

    await expect(wrapped.generate(input)).rejects.toThrow("503");
    await expect(wrapped.generate(input)).rejects.toThrow("400");
    await expect(wrapped.generate(input)).resolves.toMatchObject({ text: "reachable" });

    expect(states).toEqual(["open", "half-open", "closed"]);
  });

  it("counts failures thrown while consuming a stream", async () => {
    const model: LanguageModel = {
      provider: "test",
      modelId: "streaming",
      capabilities,
      async generate() {
        return { text: "unused" };
      },
      async stream() {
        return (async function* (): AsyncGenerator<StreamEvent> {
          yield { type: "text-delta", textDelta: "partial" };
          throw new Error("stream failed");
        })();
      }
    };
    const wrapped = wrapLanguageModel(model, [
      createCircuitBreakerMiddleware({ failureThreshold: 1, cooldownMs: 60_000 })
    ]);

    const consume = async () => {
      const events = await wrapped.stream!(input);
      for await (const _event of events) {
        // Consume the stream so provider iteration failures reach the middleware.
      }
    };

    await expect(consume()).rejects.toThrow("stream failed");
    await expect(consume()).rejects.toThrow("Circuit breaker open");
  });

  it("isolates breaker state per provider and model", async () => {
    const middleware = createCircuitBreakerMiddleware({ failureThreshold: 1, cooldownMs: 60_000 });
    const failing = wrapLanguageModel({
      provider: "test",
      modelId: "failing",
      capabilities,
      async generate() {
        throw new Error("failed");
      }
    }, [middleware]);
    const healthy = wrapLanguageModel({
      provider: "test",
      modelId: "healthy",
      capabilities,
      async generate() {
        return { text: "ok" };
      }
    }, [middleware]);

    await expect(failing.generate(input)).rejects.toThrow("failed");
    await expect(failing.generate(input)).rejects.toThrow("Circuit breaker open");
    await expect(healthy.generate(input)).resolves.toMatchObject({ text: "ok" });
  });

  it("does not let an older in-flight success close a newly opened circuit", async () => {
    let attempts = 0;
    let releaseSuccess!: () => void;
    const delayedSuccess = new Promise<void>((resolve) => {
      releaseSuccess = resolve;
    });
    const wrapped = wrapLanguageModel({
      provider: "test",
      modelId: "concurrent",
      capabilities,
      async generate() {
        attempts += 1;
        if (attempts === 1) {
          await delayedSuccess;
          return { text: "old success" };
        }
        throw new Error("new failure");
      }
    }, [createCircuitBreakerMiddleware({ failureThreshold: 1, cooldownMs: 60_000 })]);

    const olderRequest = wrapped.generate(input);
    await expect(wrapped.generate(input)).rejects.toThrow("new failure");
    releaseSuccess();
    await expect(olderRequest).resolves.toMatchObject({ text: "old success" });
    await expect(wrapped.generate(input)).rejects.toThrow("Circuit breaker open");
  });

  it("does not let state observers change model outcomes", async () => {
    const wrapped = wrapLanguageModel({
      provider: "test",
      modelId: "observer",
      capabilities,
      async generate() {
        throw new Error("provider failed");
      }
    }, [createCircuitBreakerMiddleware({
      failureThreshold: 1,
      onStateChange() {
        throw new Error("observer failed");
      }
    })]);

    await expect(wrapped.generate(input)).rejects.toThrow("provider failed");
  });
});
