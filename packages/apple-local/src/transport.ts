import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { ConfigurationError } from "@zhivex-ai/core/provider";

import { AppleLocalError } from "./errors.js";
import {
  encodeBridgeMessage,
  parseBridgeMessage,
  type AppleLocalRequest,
  type AppleLocalServerMessage,
  type AppleLocalTransport
} from "./protocol.js";

const MAX_LINE_CHARS = 32_000_000;

export interface AppleLocalStdioTransportOptions {
  /** Executable for the reference helper, for example `apple-local-bridge`. */
  command: string;
  args?: readonly string[];
  cwd?: string;
}

export interface AppleLocalInvokeTransportOptions {
  /** Tauri `invoke`, or any function that exchanges one bridge request for server messages. */
  invoke: (command: string, args: { request: AppleLocalRequest }) => Promise<AppleLocalServerMessage[]>;
  /** Tauri command name. Defaults to `apple_local_request`. */
  command?: string;
}

const throwIfAborted = (signal: AbortSignal | undefined) => {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError");
};

class LineReader {
  #lines: string[] = [];
  #waiters: Array<(line: string) => void> = [];
  #buffer = "";
  #error: Error | undefined;

  pushChunk(chunk: string) {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      this.#deliver(line);
      newline = this.#buffer.indexOf("\n");
    }
    if (this.#buffer.length > MAX_LINE_CHARS) {
      this.fail(new AppleLocalError("Apple Local bridge line exceeded the 32,000,000 character limit.", "bridge"));
    }
  }

  fail(error: Error) {
    if (this.#error) return;
    this.#error = error;
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) waiter("");
  }

  async next(signal: AbortSignal | undefined): Promise<string> {
    throwIfAborted(signal);
    if (this.#error && this.#lines.length === 0) throw this.#error;
    const queued = this.#lines.shift();
    if (queued !== undefined) return queued;
    return await new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        reject(signal?.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push((line) => {
        signal?.removeEventListener("abort", onAbort);
        if (line === "" && this.#error) reject(this.#error);
        else resolve(line);
      });
    });
  }

  #deliver(line: string) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(line);
    else this.#lines.push(line);
  }
}

export interface AppleLocalStdioTransport extends AppleLocalTransport {
  close(): void;
}

/**
 * Speaks the bridge protocol with a local executable over stdin and stdout.
 * One request is in flight at a time. A session can only respond to one prompt.
 */
export const createAppleLocalStdioTransport = (
  options: AppleLocalStdioTransportOptions
): AppleLocalStdioTransport => {
  if (typeof options.command !== "string" || options.command.trim() === "") {
    throw new ConfigurationError("Apple Local stdio transport requires a command.");
  }
  if (options.args !== undefined && options.args.some((arg) => typeof arg !== "string")) {
    throw new ConfigurationError("Apple Local stdio args must be strings.");
  }

  let child: ChildProcessWithoutNullStreams | undefined;
  let lines = new LineReader();
  let lock: Promise<void> = Promise.resolve();

  const ensureChild = () => {
    if (child && child.exitCode === null && !child.killed) return child;
    lines = new LineReader();
    const processChild = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    processChild.unref();
    child = processChild;
    const reader = lines;
    processChild.stdout.setEncoding("utf8");
    processChild.stdout.on("data", (chunk: string) => reader.pushChunk(chunk));
    processChild.on("error", (error) => {
      reader.fail(new AppleLocalError(`Apple Local bridge failed to start: ${error.message}`, "bridge", { cause: error }));
    });
    processChild.on("exit", (code) => {
      reader.fail(new AppleLocalError(`Apple Local bridge exited with code ${code ?? "unknown"}.`, "bridge"));
    });
    return processChild;
  };

  return {
    close() {
      child?.kill();
      child = undefined;
    },
    send(request, sendOptions) {
      const previous = lock;
      let release: () => void = () => undefined;
      lock = new Promise<void>((resolve) => {
        release = resolve;
      });
      return (async function* () {
        await previous;
        try {
          const processChild = ensureChild();
          const encoded = encodeBridgeMessage(request);
          if (encoded.length > MAX_LINE_CHARS) {
            throw new AppleLocalError("Apple Local request exceeded the 32,000,000 character limit.", "bridge");
          }
          processChild.stdin.write(`${encoded}\n`);
          for (;;) {
            const message = parseBridgeMessage(await lines.next(sendOptions?.signal));
            if (message.id !== request.id) {
              throw new AppleLocalError(
                `Apple Local bridge responded to "${message.id}" while "${request.id}" was in flight.`,
                "protocol"
              );
            }
            yield message;
            if ("result" in message || "error" in message) return;
          }
        } finally {
          release();
        }
      })();
    }
  };
};

/**
 * One-shot transport for a Tauri v2 command. The command returns the full
 * server-message list. Put `text-delta` events before the terminal result to stream.
 */
export const createAppleLocalInvokeTransport = (
  options: AppleLocalInvokeTransportOptions
): AppleLocalTransport => {
  if (typeof options.invoke !== "function") {
    throw new ConfigurationError("Apple Local invoke transport requires an invoke function.");
  }
  const command = options.command ?? "apple_local_request";
  return {
    async *send(request, sendOptions) {
      throwIfAborted(sendOptions?.signal);
      const messages = await options.invoke(command, { request });
      throwIfAborted(sendOptions?.signal);
      if (!Array.isArray(messages)) {
        throw new AppleLocalError("Apple Local invoke transport expected an array of bridge messages.", "protocol");
      }
      for (const message of messages) yield parseBridgeMessage(encodeBridgeMessage(message));
    }
  };
};
