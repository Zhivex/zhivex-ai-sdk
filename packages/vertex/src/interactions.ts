import { toJSONSchema } from "zod";
import {
  ConfigurationError, ProviderHTTPError, UnsupportedFeatureError,
  isCallableToolDefinition, toToolSet, readJsonWithLimit, readErrorBodyWithLimit,
  streamSSE, withRetry, withTimeoutSignal,
  type Interaction, type InteractionCreateInput, type InteractionContent,
  type InteractionResumeInput, type InteractionsClient, type RetryOptions, type StreamEvent, type JsonValue
} from "@zhivex-ai/core/provider";

export interface VertexInteractionResumeInput extends InteractionResumeInput {
  /** Ordered native events already consumed, through lastEventId. Used locally only. */
  previousEvents?: ReadonlyArray<Record<string, JsonValue>>;
}

export interface VertexInteractionsClient extends InteractionsClient {
  resume(input: VertexInteractionResumeInput): Promise<AsyncIterable<StreamEvent>>;
  list(input?: RetryOptions & { pageSize?: number; pageToken?: string }): Promise<{
    interactions: Array<{ id: string }>; nextPageToken?: string; rawResponse: unknown;
  }>;
}

const normalize = (json: any): Interaction => {
  const outputs: InteractionContent[] = json.outputs ?? (json.steps ?? [])
    .filter((value: any) => value.type === "model_output")
    .flatMap((value: any) => value.content ?? []);
  return {
    id: json.id ?? json.name ?? "", name: json.name, model: json.model, agent: json.agent,
    status: json.status, object: json.object, createTime: json.created, updateTime: json.updated,
    previousInteractionId: json.previous_interaction_id, steps: json.steps, outputs,
    outputText: outputs.filter((value) => value.type === "text").map((value) => value.text ?? "").join("") || undefined,
    outputAudio: outputs.find((value) => value.type === "audio"),
    outputImage: outputs.find((value) => value.type === "image"),
    outputVideo: outputs.find((value) => value.type === "video"),
    usage: json.usage ? { inputTokens: json.usage.total_input_tokens, outputTokens: json.usage.total_output_tokens,
      totalTokens: json.usage.total_tokens, cachedInputTokens: json.usage.total_cached_tokens,
      reasoningTokens: json.usage.total_thought_tokens } : undefined,
    error: json.error, rawResponse: json, providerMetadata: json
  };
};

// Each resumed request reconstructs local aggregation; prior outputs are not emitted.
const toolAccumulator = () => {
  const calls = new Map<number, { id: string; name: string; args: unknown; partial: string }>();
  const callIds = new Set<string>();
  const callIndices = new Set<number>();
  return {
    pending: () => calls.size,
    consume(data: any, type: string): StreamEvent | undefined {
      if (type === "step.start" && data.step?.type === "function_call") {
        if (callIds.size >= 128 || !Number.isInteger(data.index) || data.index < 0 || callIndices.has(data.index)
          || typeof data.step.id !== "string" || !data.step.id || callIds.has(data.step.id)
          || typeof data.step.name !== "string" || !data.step.name) throw new ConfigurationError("Invalid or duplicate Vertex interaction tool call.");
        callIds.add(data.step.id);
        callIndices.add(data.index);
        calls.set(data.index, { id: data.step.id, name: data.step.name, args: data.step.arguments, partial: "" });
      }
      if (type === "step.delta" && ["arguments_delta", "arguments"].includes(data.delta?.type)) {
        const call = calls.get(data.index);
        if (!call || typeof data.delta.partial_arguments !== "string") throw new ConfigurationError("Invalid Vertex interaction tool arguments.");
        call.partial += data.delta.partial_arguments;
        if (call.partial.length > 1024 * 1024) throw new ConfigurationError("Vertex interaction tool arguments exceeded limit.");
      }
      if (type === "step.stop" && calls.has(data.index)) {
        const call = calls.get(data.index)!;
        let args = call.args;
        if (call.partial) {
          try { args = JSON.parse(call.partial); }
          catch { throw new ConfigurationError("Invalid JSON in Vertex interaction tool arguments."); }
        }
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new ConfigurationError("Vertex interaction tool arguments must be an object.");
        calls.delete(data.index);
        return { type: "tool-call", toolCall: { id: call.id, name: call.name, input: args as Record<string, JsonValue> } } satisfies StreamEvent;
      }
      return undefined;
    }
  };
};

/** Vertex's project-scoped Interactions HTTP API; unrelated to prediction operations. */
export const createVertexInteractionsClient = (
  baseURL: string, fetcher: typeof globalThis.fetch, assertAccess: () => void
): VertexInteractionsClient => {
  const collection = `${baseURL.replace(/\/v1(?:beta1)?\//, "/v1beta1/")}/interactions`;
  const resource = (id: string) => {
    if (!id || /[\\/?#\s]/.test(id) || id === "." || id === "..") throw new ConfigurationError("Invalid Vertex interaction ID.");
    return `${collection}/${encodeURIComponent(id)}`;
  };
  const body = (input: InteractionCreateInput, stream: boolean) => {
    if (Boolean(input.modelId) === Boolean(input.agent)) throw new ConfigurationError("Vertex Interactions requires exactly one modelId or agent.");
    if (input.modelId === "lyria-3-clip-preview" && input.store === true) {
      throw new UnsupportedFeatureError("Vertex Lyria 3 Clip requires store: false; stored interaction retrieval/resumption is unavailable on this route.");
    }
    if (input.modelId && /^(lyria-3|gemini-omni)/.test(input.modelId) && !baseURL.endsWith("/locations/global")) {
      throw new ConfigurationError("Vertex Interactions media models require location global.");
    }
    const tools = input.tools ? Object.values(toToolSet(input.tools) ?? {}).map((tool) => {
      if (isCallableToolDefinition(tool)) return { type: "function", name: tool.name, description: tool.description, parameters: toJSONSchema(tool.schema) };
      if (tool.provider && tool.provider !== "vertex") throw new UnsupportedFeatureError("Vertex Interactions cannot use another provider's hosted tools.");
      const aliases: Record<string, string> = { googleSearch: "google_search", googleMaps: "google_maps", urlContext: "url_context", codeExecution: "code_execution", computerUse: "computer_use", vertexSearch: "retrieval" };
      const type = aliases[tool.type] ?? tool.type;
      if (!["google_search", "google_maps", "url_context", "code_execution", "computer_use", "mcp_server", "retrieval"].includes(type)) throw new UnsupportedFeatureError(`Vertex Interactions does not expose hosted tool "${tool.type}"; use its documented native tool contract.`);
      const config = { ...(tool.config && typeof tool.config === "object" && !Array.isArray(tool.config) ? tool.config : {}) };
      if (type === "google_maps" && config.enableWidget !== undefined) {
        if (config.enable_widget !== undefined) throw new ConfigurationError("Specify only one Google Maps widget option.");
        config.enable_widget = config.enableWidget;
        delete config.enableWidget;
      }
      if (tool.type === "vertexSearch") return { type, retrieval_types: ["vertex_ai_search"], vertex_ai_search_config: config };
      return { ...config, type };
    }) : undefined;
    return { ...input.providerOptions, model: input.modelId, agent: input.agent, input: input.input,
      ...(tools ? { tools } : {}), previous_interaction_id: input.previousInteractionId,
      system_instruction: input.systemInstruction, response_format: input.responseFormat,
      generation_config: input.generationConfig, agent_config: input.agentConfig,
      environment: input.environment, labels: input.labels, background: input.background,
      store: input.store ?? (input.modelId === "lyria-3-clip-preview" ? false : undefined), stream };
  };
  const request = async (url: string, init: RequestInit, signal: AbortSignal | undefined, input: RetryOptions) => {
    assertAccess();
    return withRetry(async () => {
      const response = await fetcher(url, { ...init, redirect: "error", signal,
        headers: { "content-type": "application/json", "Api-Revision": "2026-05-20", ...init.headers } });
      if (!response.ok) throw new ProviderHTTPError(`Vertex Interactions failed with status ${response.status}.`, response.status, { responseBody: await readErrorBodyWithLimit(response) });
      return response;
    }, { ...input, abortSignal: signal });
  };
  const json = async (url: string, init: RequestInit, input: RetryOptions) => {
    const { signal, cleanup } = withTimeoutSignal(input);
    try { return await readJsonWithLimit(await request(url, init, signal, input), { maxBytes: 128 * 1024 * 1024 }); }
    finally { cleanup(); }
  };
  const stream = async (input: InteractionCreateInput | VertexInteractionResumeInput): Promise<AsyncIterable<StreamEvent>> => {
    const tools = toolAccumulator();
    if ("id" in input && input.previousEvents !== undefined) {
      let serialized: string;
      try { serialized = JSON.stringify(input.previousEvents); }
      catch { throw new ConfigurationError("Interaction resume history must be JSON serializable."); }
      const history = JSON.parse(serialized);
      if (!Array.isArray(history) || !history.length || history.length > 16_384
        || !input.lastEventId || new TextEncoder().encode(serialized).byteLength > 8 * 1024 * 1024) {
        throw new ConfigurationError("Interaction resume history requires a cursor and 1-16384 events within 8 MiB.");
      }
      for (const event of history) {
        if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.event_type !== "string") throw new ConfigurationError("Invalid interaction resume event.");
        const interaction = event.interaction as Record<string, JsonValue> | undefined;
        if ((interaction?.id !== undefined && interaction.id !== input.id)
          || (event.interaction_id !== undefined && event.interaction_id !== input.id)) throw new ConfigurationError("Interaction resume history belongs to another interaction.");
        tools.consume(event, event.event_type);
      }
      if (history.at(-1)?.event_id !== input.lastEventId) throw new ConfigurationError("Interaction resume history does not match lastEventId.");
    }
    const { signal, cleanup } = withTimeoutSignal(input);
    let response: Response;
    try {
      const url = new URL("id" in input ? resource(input.id) : collection);
      if ("id" in input) {
        url.searchParams.set("stream", "true");
        if (input.lastEventId) url.searchParams.set("last_event_id", input.lastEventId);
      }
      response = await request(url.toString(), "id" in input ? { method: "GET" } : { method: "POST", body: JSON.stringify(body(input, true)) }, signal, input);
    } catch (error) { cleanup(); throw error; }
    return (async function* () {
      let finished = false;
      try {
        for await (const event of streamSSE(response)) {
          if (event.data === "[DONE]") continue;
          const data = JSON.parse(event.data);
          const type = data.event_type ?? data.type ?? event.event;
          if (type === "error") throw new ProviderHTTPError("Vertex Interactions stream failed.", 500, { responseBody: event.data });
          yield { type: "provider-data", provider: "vertex", data: { ...data, event_type: type } } satisfies StreamEvent;
          const toolEvent = tools.consume(data, type);
          if (toolEvent) yield toolEvent;
          if (type === "step.delta" && data.delta?.type === "text" && typeof data.delta.text === "string") yield { type: "text-delta", textDelta: data.delta.text } satisfies StreamEvent;
          if (type === "step.start") for (const content of data.step?.content ?? []) {
            if (content.type === "text" && typeof content.text === "string") yield { type: "text-delta", textDelta: content.text } satisfies StreamEvent;
          }
          const status = data.interaction?.status ?? data.status ?? (typeof type === "string" && type.startsWith("interaction.") ? type.slice("interaction.".length) : undefined);
          if (!finished && ["completed", "requires_action", "failed", "cancelled", "incomplete", "budget_exceeded"].includes(status)) {
            if (tools.pending()) throw new ConfigurationError("Vertex interaction ended with incomplete tool calls.");
            finished = true;
            yield { type: "finish", finishReason: status === "completed" ? "stop" : status === "requires_action" ? "tool-calls" : ["incomplete", "budget_exceeded"].includes(status) ? "length" : "error", providerFinishReason: status,
              usage: normalize(data.interaction ?? data).usage } satisfies StreamEvent;
            break;
          }
        }
        if (!finished) throw new ConfigurationError("Vertex interaction stream ended without a terminal event; resume with the last event ID.");
      } finally {
        await response.body?.cancel().catch(() => {});
        cleanup();
      }
    })();
  };
  return {
    create: async (input) => normalize(await json(collection, { method: "POST", body: JSON.stringify(body(input, false)) }, input)),
    get: async (input) => normalize(await json(resource(input.id), { method: "GET" }, input)),
    cancel: async (input) => normalize(await json(`${resource(input.id)}/cancel`, { method: "POST" }, input)),
    async delete(input) {
      const { signal, cleanup } = withTimeoutSignal(input);
      try { const response = await request(resource(input.id), { method: "DELETE" }, signal, input); await response.body?.cancel(); return { id: input.id }; }
      finally { cleanup(); }
    },
    async list(input = {}) {
      if (input.pageSize !== undefined && (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 500)) throw new ConfigurationError("Vertex interaction pageSize must be 1-500.");
      const url = new URL(collection);
      if (input.pageSize) url.searchParams.set("page_size", String(input.pageSize));
      if (input.pageToken) url.searchParams.set("page_token", input.pageToken);
      const result: any = await json(url.toString(), { method: "GET" }, input);
      return { interactions: result.interaction_metadatas ?? [], nextPageToken: result.next_page_token, rawResponse: result };
    },
    stream, resume: stream
  };
};
