export const DEFAULT_STREAM_REPLAY_LIMIT = 4_096;
export const DEFAULT_STREAM_SUBSCRIBER_LIMIT = 256;
export const DEFAULT_STREAM_TERMINAL_LIMIT = 8;

export class StreamBufferOverflowError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`Stream replay buffer exceeded its limit of ${limit} events.`);
    this.name = "StreamBufferOverflowError";
    this.limit = limit;
  }
}

type PublishedValue<T> = {
  sequence: number;
  value: T;
};

type Subscriber<T> = {
  accepts: (value: T) => boolean;
  queue: PublishedValue<T>[];
  wake?: () => void;
  spaceWaiters: Set<() => void>;
};

export interface BoundedReplayBroadcastOptions {
  maxHistory?: number;
  maxSubscriberQueue?: number;
  maxTerminalHistory?: number;
}

export interface PublishOptions {
  replay?: boolean;
  /** Allows a bounded number of lifecycle/finish events beyond replay capacity. */
  terminal?: boolean;
}

const positiveInteger = (value: number | undefined, fallback: number, name: string) => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
  return resolved;
};

/**
 * A bounded multicast stream with deterministic replay.
 *
 * Active slow consumers apply backpressure to publishers once their private
 * queue reaches `maxSubscriberQueue`. Retained replay never silently drops an
 * event: exceeding `maxHistory` fails the broadcast and its iterators.
 */
export class BoundedReplayBroadcast<T> {
  private readonly maxHistory: number;
  private readonly maxSubscriberQueue: number;
  private readonly maxTerminalHistory: number;
  private readonly history: PublishedValue<T>[] = [];
  private readonly subscribers = new Set<Subscriber<T>>();
  private sequence = 0;
  private terminalHistory = 0;
  private closed = false;
  private failure: unknown;

  constructor(options: BoundedReplayBroadcastOptions = {}) {
    this.maxHistory = positiveInteger(options.maxHistory, DEFAULT_STREAM_REPLAY_LIMIT, "maxHistory");
    this.maxSubscriberQueue = positiveInteger(
      options.maxSubscriberQueue,
      DEFAULT_STREAM_SUBSCRIBER_LIMIT,
      "maxSubscriberQueue"
    );
    this.maxTerminalHistory = positiveInteger(
      options.maxTerminalHistory,
      DEFAULT_STREAM_TERMINAL_LIMIT,
      "maxTerminalHistory"
    );
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async publish(value: T, options: PublishOptions = {}): Promise<void> {
    this.assertWritable();

    if (options.replay !== false && !options.terminal && this.history.length - this.terminalHistory >= this.maxHistory) {
      const error = new StreamBufferOverflowError(this.maxHistory);
      this.fail(error);
      throw error;
    }

    if (options.terminal && this.terminalHistory >= this.maxTerminalHistory) {
      const error = new StreamBufferOverflowError(this.maxHistory + this.maxTerminalHistory);
      this.fail(error);
      throw error;
    }

    const item = { sequence: this.sequence, value } satisfies PublishedValue<T>;
    this.sequence += 1;
    if (options.replay !== false) {
      this.history.push(item);
      if (options.terminal) {
        this.terminalHistory += 1;
      }
    }

    await Promise.all(
      [...this.subscribers].map(async (subscriber) => {
        if (!subscriber.accepts(value)) {
          return;
        }

        while (subscriber.queue.length >= this.maxSubscriberQueue && this.subscribers.has(subscriber)) {
          await new Promise<void>((resolve) => subscriber.spaceWaiters.add(resolve));
        }

        if (!this.subscribers.has(subscriber)) {
          return;
        }
        this.assertWritable();
        subscriber.queue.push(item);
        subscriber.wake?.();
        subscriber.wake = undefined;
      })
    );
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.releaseAll();
  }

  fail(error: unknown): void {
    if (this.closed) {
      return;
    }
    this.failure = error;
    this.closed = true;
    this.releaseAll();
  }

  stream(accepts: (value: T) => boolean = () => true): AsyncIterable<T> {
    const self = this;
    return (async function* () {
      const replayThrough = self.sequence;
      const subscriber: Subscriber<T> = {
        accepts,
        queue: [],
        spaceWaiters: new Set()
      };
      if (!self.closed) {
        self.subscribers.add(subscriber);
      }

      try {
        for (const item of self.history) {
          if (item.sequence >= replayThrough) {
            break;
          }
          if (accepts(item.value)) {
            yield item.value;
          }
        }

        while (true) {
          while (subscriber.queue.length) {
            const item = subscriber.queue.shift()!;
            self.releaseSpace(subscriber);
            yield item.value;
          }

          if (self.closed) {
            if (self.failure !== undefined) {
              throw self.failure;
            }
            return;
          }

          await new Promise<void>((resolve) => {
            subscriber.wake = resolve;
          });
        }
      } finally {
        self.subscribers.delete(subscriber);
        subscriber.queue.length = 0;
        subscriber.wake = undefined;
        self.releaseSpace(subscriber);
      }
    })();
  }

  private assertWritable() {
    if (this.failure !== undefined) {
      throw this.failure;
    }
    if (this.closed) {
      throw new Error("Cannot publish to a closed stream.");
    }
  }

  private releaseSpace(subscriber: Subscriber<T>) {
    for (const resolve of subscriber.spaceWaiters) {
      resolve();
    }
    subscriber.spaceWaiters.clear();
  }

  private releaseAll() {
    for (const subscriber of this.subscribers) {
      subscriber.wake?.();
      subscriber.wake = undefined;
      this.releaseSpace(subscriber);
    }
  }
}
