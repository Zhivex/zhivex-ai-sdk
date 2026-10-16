import { z } from "zod";

import {
  A2A_PROTOCOL_VERSION,
  A2aProtocolError,
  assertA2aDestination,
  createA2aId,
  type A2aAgentCard,
  type A2aMessage,
  type A2aPart,
  type A2aStreamResponse,
  type A2aTask,
  type AssertA2aDestinationOptions
} from "./a2a-protocol.js";
import type { JsonValue, ToolDefinition } from "./types.js";

export interface RemoteA2aAgentOptions extends AssertA2aDestinationOptions {
  /**
   * Agent Card URL, or an origin whose `/.well-known/agent-card.json` is fetched.
   * Every card and RPC URL is checked again before it is used.
   */
  url: string;
  /** Skip the card fetch when the caller already holds a trusted card. Interface URLs are still checked. */
  card?: A2aAgentCard;
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  fetch?: typeof fetch;
  maxResponseBytes?: number;
  timeoutMs?: number;
}

export interface A2aClientMessage {
  text?: string;
  parts?: A2aPart[];
  taskId?: string;
  contextId?: string;
  messageId?: string;
  configuration?: {
    returnImmediately?: boolean;
    historyLength?: number;
  };
}

const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 60_000;
const remoteToolSchema = z.object({
  prompt: z.string().min(1),
  taskId: z.string().min(1).optional(),
  contextId: z.string().min(1).optional()
});
const toolNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface CreateRemoteA2aAgentToolOptions {
  agent: RemoteA2aAgent | RemoteA2aAgentOptions;
  name?: string;
  description?: string;
}

export class RemoteA2aAgent {
  readonly #options: RemoteA2aAgentOptions;
  readonly #fetch: typeof fetch;
  #cardPromise: Promise<A2aAgentCard> | undefined;
  #rpcUrl: Promise<URL> | undefined;

  constructor(options: RemoteA2aAgentOptions) {
    if (!options.url && !options.card) {
      throw new A2aProtocolError("INVALID_PARAMS", "A remote A2A agent requires a card URL.");
    }
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  card(): Promise<A2aAgentCard> {
    this.#cardPromise ??= this.#loadCard();
    return this.#cardPromise;
  }

  async send(input: A2aClientMessage): Promise<A2aTask> {
    const result = await this.#rpc("SendMessage", await this.#sendParams(input));
    return taskFromResult(result);
  }

  async *stream(input: A2aClientMessage): AsyncGenerator<A2aStreamResponse> {
    const response = await this.#request(await this.#endpoint(), await this.#sendParams(input), "SendStreamingMessage");
    if (!response.ok || !response.body) {
      throw new A2aProtocolError("PROTOCOL_ERROR", "A2A streaming request failed.");
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      throw new A2aProtocolError("PROTOCOL_ERROR", "A2A streaming response was not an event stream.");
    }
    yield* readEventStream(response, limit(this.#options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES));
  }

  async getTask(id: string, historyLength?: number): Promise<A2aTask> {
    const params: Record<string, unknown> = { id };
    if (historyLength !== undefined) params.historyLength = historyLength;
    return asTask(await this.#rpc("GetTask", params));
  }

  async cancelTask(id: string): Promise<A2aTask> {
    return asTask(await this.#rpc("CancelTask", { id }));
  }

  async #loadCard(): Promise<A2aAgentCard> {
    if (this.#options.card) {
      await this.#endpoint();
      return this.#options.card;
    }
    let cardUrl: URL;
    try {
      cardUrl = await assertA2aDestination(cardUrlFor(this.#options.url), this.#options);
    } catch (error) {
      if (error instanceof A2aProtocolError) throw error;
      throw new A2aProtocolError("DESTINATION_REJECTED", "A2A destination rejected by policy.");
    }
    const response = await this.#request(cardUrl, undefined, undefined);
    if (!response.ok) {
      throw new A2aProtocolError("PROTOCOL_ERROR", "A2A agent card request failed.");
    }
    const body = await readBoundedJson(response, limit(this.#options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES));
    if (!isRecord(body)) {
      throw new A2aProtocolError("PROTOCOL_ERROR", "A2A agent card was not an object.");
    }
    return body as unknown as A2aAgentCard;
  }

  async #endpoint(): Promise<URL> {
    this.#rpcUrl ??= this.#resolveEndpoint();
    return this.#rpcUrl;
  }

  async #resolveEndpoint(): Promise<URL> {
    const card = this.#options.card ?? await this.card();
    const selected = card.supportedInterfaces?.find((candidate) =>
      candidate.protocolBinding === "JSONRPC" && candidate.protocolVersion === A2A_PROTOCOL_VERSION
    );
    if (!selected?.url) {
      throw new A2aProtocolError("PROTOCOL_ERROR", "A2A agent card has no JSON-RPC 1.0 interface.");
    }
    return assertA2aDestination(selected.url, this.#options);
  }

  async #sendParams(input: A2aClientMessage): Promise<Record<string, unknown>> {
    const parts = input.parts ? [...input.parts] : [];
    if (input.text !== undefined) parts.unshift({ text: input.text });
    if (!parts.length) throw new A2aProtocolError("INVALID_PARAMS", "Invalid parameters.");
    const card = await this.card();
    const selected = card.supportedInterfaces?.find((candidate) =>
      candidate.protocolBinding === "JSONRPC" && candidate.protocolVersion === A2A_PROTOCOL_VERSION
    );
    const message: A2aMessage = {
      messageId: input.messageId ?? createA2aId("msg"),
      role: "ROLE_USER",
      parts
    };
    if (input.taskId) message.taskId = input.taskId;
    if (input.contextId) message.contextId = input.contextId;
    const params: Record<string, unknown> = { message };
    if (selected?.tenant) params.tenant = selected.tenant;
    if (input.configuration) params.configuration = input.configuration;
    return params;
  }

  async #rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const response = await this.#request(await this.#endpoint(), params, method);
    const body = await readBoundedJson(response, limit(this.#options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES));
    if (!response.ok && !isRecord(body)) {
      throw new A2aProtocolError("PROTOCOL_ERROR", "A2A request failed.");
    }
    return unwrapRpc(body);
  }

  async #request(url: URL, params: Record<string, unknown> | undefined, method: string | undefined): Promise<Response> {
    const headers = new Headers(await resolveHeaders(this.#options.headers));
    headers.set("a2a-version", A2A_PROTOCOL_VERSION);
    if (method) headers.set("content-type", "application/json");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limit(this.#options.timeoutMs, DEFAULT_TIMEOUT_MS));
    try {
      return await this.#fetch(url, {
        method: method ? "POST" : "GET",
        headers,
        body: method ? JSON.stringify({
          jsonrpc: "2.0",
          id: createA2aId("rpc"),
          method,
          params
        }) : undefined,
        redirect: "error",
        signal: controller.signal
      });
    } catch (error) {
      if (error instanceof A2aProtocolError) throw error;
      throw new A2aProtocolError("PROTOCOL_ERROR", "A2A request failed.");
    } finally {
      clearTimeout(timer);
    }
  }
}

export const createRemoteA2aAgent = (options: RemoteA2aAgentOptions): RemoteA2aAgent => new RemoteA2aAgent(options);

/**
 * Exposes a remote A2A agent as a Zhivex tool so a parent agent can call it
 * from `tools` the same way it calls a local subagent tool.
 * `TASK_STATE_INPUT_REQUIRED` is returned to the parent instead of blocking it.
 */
export const createRemoteA2aAgentTool = (
  options: CreateRemoteA2aAgentToolOptions
): ToolDefinition<typeof remoteToolSchema, JsonValue> => {
  const name = options.name ?? "remote_a2a_agent";
  if (!toolNamePattern.test(name)) {
    throw new A2aProtocolError("INVALID_PARAMS", "Remote A2A tool name is invalid.");
  }
  const agent = options.agent instanceof RemoteA2aAgent ? options.agent : createRemoteA2aAgent(options.agent);
  return {
    name,
    description: options.description ?? "Delegate the prompt to a remote A2A agent and return its task.",
    schema: remoteToolSchema,
    metadata: { type: "remote-a2a-agent", stability: "experimental" },
    execute: async (input) => {
      const task = await agent.send({
        text: input.prompt,
        taskId: input.taskId,
        contextId: input.contextId
      });
      return {
        taskId: task.id,
        contextId: task.contextId,
        state: task.status.state,
        text: textFromTask(task)
      };
    }
  };
};

const cardUrlFor = (value: string): string => {
  const url = new URL(value);
  if (url.pathname.endsWith("agent-card.json")) return url.href;
  url.pathname = `${url.pathname.replace(/\/$/, "")}/.well-known/agent-card.json`;
  url.search = "";
  url.hash = "";
  return url.href;
};

const resolveHeaders = async (
  headers: RemoteA2aAgentOptions["headers"]
): Promise<Record<string, string>> => {
  if (!headers) return {};
  return typeof headers === "function" ? await headers() : headers;
};

const limit = (value: number | undefined, fallback: number): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new A2aProtocolError("INVALID_PARAMS", "A2A limits must be positive safe integers.");
  }
  return resolved;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const unwrapRpc = (body: unknown): unknown => {
  if (!isRecord(body) || body.error !== undefined) {
    throw new A2aProtocolError("PROTOCOL_ERROR", "A2A request failed.");
  }
  return body.result;
};

const taskFromResult = (result: unknown): A2aTask => {
  if (!isRecord(result) || !isRecord(result.task)) {
    throw new A2aProtocolError("PROTOCOL_ERROR", "A2A response did not contain a task.");
  }
  return result.task as unknown as A2aTask;
};

const asTask = (result: unknown): A2aTask => {
  if (!isRecord(result) || typeof result.id !== "string" || !isRecord(result.status)) {
    throw new A2aProtocolError("PROTOCOL_ERROR", "A2A response did not contain a task.");
  }
  return result as unknown as A2aTask;
};

const textFromTask = (task: A2aTask): string => {
  const artifactText = (task.artifacts ?? [])
    .flatMap((artifact) => artifact.parts)
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
  if (artifactText) return artifactText;
  return (task.status.message?.parts ?? [])
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
};

const readBoundedJson = async (response: Response, maxBytes: number): Promise<unknown> => {
  const text = await readBoundedText(response, maxBytes);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof A2aProtocolError) throw error;
    throw new A2aProtocolError("PROTOCOL_ERROR", "Invalid A2A JSON response.");
  }
};

const readBoundedText = async (response: Response, maxBytes: number): Promise<string> => {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new A2aProtocolError("LIMIT_EXCEEDED", "A2A response exceeded byte limit.");
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    if (error instanceof A2aProtocolError) throw error;
    throw new A2aProtocolError("PROTOCOL_ERROR", "Invalid A2A response.");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

async function* readEventStream(response: Response, maxBytes: number): AsyncGenerator<A2aStreamResponse> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let buffer = "";
  const take = function* (next: string): Generator<A2aStreamResponse, string> {
    let rest = next.replace(/\r\n/g, "\n");
    let split = rest.indexOf("\n\n");
    while (split !== -1) {
      const raw = rest.slice(0, split);
      rest = rest.slice(split + 2);
      const data = raw
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data) as unknown;
        } catch {
          throw new A2aProtocolError("PROTOCOL_ERROR", "Invalid A2A event stream.");
        }
        if (!isRecord(parsed) || parsed.error !== undefined || !isRecord(parsed.result)) {
          throw new A2aProtocolError("PROTOCOL_ERROR", "A2A request failed.");
        }
        yield parsed.result as A2aStreamResponse;
      }
      split = rest.indexOf("\n\n");
    }
    return rest;
  };
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      if (!chunk.done) {
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) throw new A2aProtocolError("LIMIT_EXCEEDED", "A2A response exceeded byte limit.");
      } else {
        buffer += "\n\n";
      }
      const iterator = take(buffer);
      let step = iterator.next();
      while (!step.done) {
        yield step.value;
        step = iterator.next();
      }
      buffer = step.value;
      if (chunk.done) return;
    }
  } catch (error) {
    if (error instanceof A2aProtocolError) throw error;
    throw new A2aProtocolError("PROTOCOL_ERROR", "Invalid A2A event stream.");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
