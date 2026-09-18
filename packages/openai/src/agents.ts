import {
  ConfigurationError, ParseError, ProviderHTTPError, ValidationError, assertTrustedEndpoint, readErrorBodyWithLimit,
  readBodyWithLimit, readJsonWithLimit, streamSSE, withTimeoutSignal, type JsonValue
} from "@zhivex-ai/core/provider";

export interface OpenAIAgentsRequestOptions {
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

/** Native Beta payloads retain new provider fields without translating them into local agent state. */
export interface OpenAIAgentSessionInput {
  agent: { model: string; instructions?: string; [key: string]: JsonValue | undefined };
  environment: { type: string; [key: string]: JsonValue | undefined };
  input?: string | JsonValue[];
  [key: string]: unknown;
}

export interface OpenAIAgentEvent {
  type: string;
  [key: string]: JsonValue;
}

export interface OpenAIAgentSession {
  id: string;
  [key: string]: JsonValue;
}

export interface OpenAIAgentsPage {
  data: JsonValue[];
  has_more?: boolean;
  first_id?: string;
  last_id?: string;
  [key: string]: JsonValue | undefined;
}

const sessionPath = (id: string) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new ValidationError("Invalid OpenAI agent session ID.");
  return `/agents/sessions/${encodeURIComponent(id)}`;
};

const queryString = (query: Record<string, string | number | boolean | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
  return params.size ? `?${params}` : "";
};

/** Native OpenAI Agents API. Mutations are never automatically retried. */
export class OpenAIAgentsClient {
  private readonly baseURL: string;

  constructor(baseURL: string, private readonly apiKey: string, private readonly fetcher: typeof fetch = globalThis.fetch, allowUnsafeEndpoints = false) {
    if (!apiKey) throw new ConfigurationError("Missing OpenAI API key.");
    this.baseURL = assertTrustedEndpoint(baseURL, {
      label: "OpenAI Agents baseURL", protocols: ["https"], allowUnsafe: allowUnsafeEndpoints
    }).toString().replace(/\/+$/, "");
  }

  private async response(path: string, method: string, body: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    const response = await this.fetcher(`${this.baseURL}${path}`, {
      method, signal, redirect: "error",
      headers: { authorization: `Bearer ${this.apiKey}`, "OpenAI-Beta": "agents=v1", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) throw new ProviderHTTPError("OpenAI Agents request failed.", response.status, {
      responseBody: await readErrorBodyWithLimit(response, 64 * 1024)
    });
    return response;
  }

  private async json<T>(path: string, method: string, body: unknown, options: OpenAIAgentsRequestOptions = {}, acceptEmpty = false): Promise<T> {
    const { signal, cleanup } = withTimeoutSignal(options);
    try {
      const response = await this.response(path, method, body, signal);
      if (response.status === 204) return undefined as T;
      // Event submission/cancellation is acknowledged with an empty HTTP 202.
      if (acceptEmpty && response.status === 202) {
        const bytes = await readBodyWithLimit(response, { maxBytes: 8 * 1024 * 1024 });
        if (!bytes.byteLength) return undefined as T;
        try { return JSON.parse(new TextDecoder().decode(bytes)) as T; }
        catch (cause) { throw new ParseError("Invalid OpenAI Agents acknowledgement JSON.", { cause }); }
      }
      return await readJsonWithLimit<T>(response, { maxBytes: 8 * 1024 * 1024 });
    } finally { cleanup(); }
  }

  private async *stream(path: string, method: string, body: unknown, options: OpenAIAgentsRequestOptions = {}): AsyncGenerator<OpenAIAgentEvent> {
    const { signal, cleanup } = withTimeoutSignal(options);
    let response: Response | undefined;
    try {
      response = await this.response(path, method, body, signal);
      for await (const event of streamSSE(response)) {
        if (event.data === "[DONE]") return;
        if (!event.data) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(event.data); } catch (cause) { throw new ParseError("Invalid OpenAI Agents event JSON.", { cause }); }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as OpenAIAgentEvent).type !== "string") {
          throw new ParseError("OpenAI Agents event must contain a type.");
        }
        // Preserve lifecycle failures, tool requests, IDs and future events verbatim.
        // Neither idle nor a subagent completion is treated as root-turn success.
        yield parsed as OpenAIAgentEvent;
      }
    } finally {
      await response?.body?.cancel().catch(() => undefined);
      cleanup();
    }
  }

  createSession(input: OpenAIAgentSessionInput, options?: OpenAIAgentsRequestOptions) {
    return this.json<OpenAIAgentSession>("/agents/sessions", "POST", { ...input, stream: false }, options);
  }
  streamSession(input: OpenAIAgentSessionInput, options?: OpenAIAgentsRequestOptions) {
    return this.stream("/agents/sessions", "POST", { ...input, stream: true }, options);
  }
  getSession(id: string, options?: OpenAIAgentsRequestOptions) {
    return this.json<OpenAIAgentSession>(sessionPath(id), "GET", undefined, options);
  }
  deleteSession(id: string, options?: OpenAIAgentsRequestOptions) {
    return this.json<JsonValue | undefined>(sessionPath(id), "DELETE", undefined, options);
  }
  sendEvents(id: string, events: OpenAIAgentEvent[], options?: OpenAIAgentsRequestOptions) {
    if (!events.length) throw new ValidationError("At least one agent input event is required.");
    return this.json<JsonValue | undefined>(`${sessionPath(id)}/events`, "POST", { events }, options, true);
  }
  cancelTurn(id: string, options?: OpenAIAgentsRequestOptions) {
    return this.sendEvents(id, [{ type: "agent.session.input.cancel" }], options);
  }
  streamEvents(id: string, options?: OpenAIAgentsRequestOptions) {
    return this.stream(`${sessionPath(id)}/events?stream=true`, "GET", undefined, options);
  }
  listItems(id: string, query: { after?: string; before?: string; limit?: number; order?: "asc" | "desc" } = {}, options?: OpenAIAgentsRequestOptions) {
    return this.json<OpenAIAgentsPage>(`${sessionPath(id)}/items${queryString(query)}`, "GET", undefined, options);
  }
}
