import { z } from "zod";
import { ConfigurationError, type JsonValue, type ToolDefinition, type ToolExecutionContext } from "@zhivex-ai/core/provider";

export interface OpenAIComputerSafetyCheck {
  id: string;
  code?: string | null;
  message?: string | null;
  [key: string]: JsonValue | undefined;
}

export interface OpenAIComputerCallInput {
  actions: JsonValue[];
  /** Provider call identity, included in approvals and correlated with the result. */
  call_id?: string;
  pending_safety_checks?: OpenAIComputerSafetyCheck[];
}

export interface OpenAIComputerScreenshotOutput {
  type: "computer_screenshot";
  image_url: string;
  detail?: "original";
}

export interface OpenAIComputerExecutionContext extends Partial<ToolExecutionContext> {
  abortSignal: AbortSignal;
  deadline: number;
}

export interface OpenAIComputerToolConfig {
  name?: string;
  requiresApproval?: boolean;
  /** Per callback deadline; defaults to 60 seconds. Cancellation cannot undo effects. */
  callbackTimeoutMs?: number;
  /** Explicitly confirm every supplied provider warning for this immutable call. */
  approveSafetyChecks?: (input: OpenAIComputerCallInput, context: OpenAIComputerExecutionContext) => boolean | Promise<boolean>;
  execute: (input: OpenAIComputerCallInput, context: OpenAIComputerExecutionContext) => Promise<OpenAIComputerScreenshotOutput> | OpenAIComputerScreenshotOutput;
}

const point = { x: z.number().int().nonnegative(), y: z.number().int().nonnegative() };
const action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), ...point, button: z.enum(["left", "right", "wheel", "back", "forward"]).optional() }).strict(),
  z.object({ type: z.literal("double_click"), ...point }).strict(),
  z.object({ type: z.literal("move"), ...point }).strict(),
  z.object({ type: z.literal("drag"), path: z.array(z.object(point).strict()).min(1).max(1000) }).strict(),
  z.object({ type: z.literal("scroll"), ...point, scroll_x: z.number().int(), scroll_y: z.number().int() }).strict(),
  z.object({ type: z.literal("keypress"), keys: z.array(z.string().min(1).max(128)).min(1).max(16) }).strict(),
  z.object({ type: z.literal("type"), text: z.string().max(16000) }).strict(),
  z.object({ type: z.literal("wait") }).strict(),
  z.object({ type: z.literal("screenshot") }).strict()
]);
export type OpenAIComputerAction = z.infer<typeof action>;
const check = z.object({ id: z.string().min(1), code: z.string().nullable().optional(), message: z.string().nullable().optional() }).catchall(z.json());
export const computerInputSchema = z.object({
  actions: z.array(action).min(1).max(100),
  call_id: z.string().min(1).optional(),
  pending_safety_checks: z.array(check).max(100).optional()
}).superRefine((input, ctx) => {
  const ids = input.pending_safety_checks?.map((entry) => entry.id) ?? [];
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "Duplicate computer safety check identifiers." });
});

export const computerScreenshotSchema = z.object({
  type: z.literal("computer_screenshot"),
  image_url: z.string().max(12 * 1024 * 1024).refine((value) => /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) || /^https:\/\/\S+$/.test(value), "Expected an image data URL or HTTPS URL."),
  detail: z.literal("original").optional()
});

const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

/** External effects may have occurred: reconcile the application session before retrying. */
export class OpenAIComputerExecutionError extends Error {
  readonly effectsPossible = true;
  readonly retryable = false;
  readonly outcome = "unknown";
  constructor(readonly callId: string | undefined, cause: unknown) {
    super("OpenAI computer execution outcome is unknown; reconcile the session before retrying.", { cause });
    this.name = "OpenAIComputerExecutionError";
  }
}

const callback = async <T>(operation: (signal: AbortSignal) => Promise<T> | T, timeoutMs: number, parent?: AbortSignal): Promise<T> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => { controller.abort(parent?.reason); reject(parent?.reason ?? new Error("Computer callback aborted.")); };
      if (parent?.aborted) { abort(); return; }
      parent?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => { const error = new Error("Computer callback timed out."); controller.abort(error); reject(error); }, timeoutMs);
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }).then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
  }
};

export const openAIComputerTool = (config: OpenAIComputerToolConfig): ToolDefinition<z.ZodType<OpenAIComputerCallInput>, JsonValue> => {
  const timeout = config.callbackTimeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 86_400_000) throw new ConfigurationError("computer callbackTimeoutMs must be a positive integer no greater than 86400000.");
  if (typeof config.execute !== "function") throw new ConfigurationError("OpenAI computer requires an application-owned executor.");
  // Retain completed IDs only while their invocation context remains reachable.
  // Direct execute calls have no invocation lifecycle; guard only overlapping work.
  const scopedCalls = new WeakMap<object, Set<string>>();
  const inFlightCalls = new Set<string>();
  return {
    name: config.name ?? "computer",
    description: "Execute authorized ordered OpenAI computer actions and return the same session's screenshot.",
    requiresApproval: config.requiresApproval ?? true,
    metadata: { "openai.responses_tool_type": "computer", "openai.responses_tool_config": {} },
    schema: computerInputSchema as z.ZodType<OpenAIComputerCallInput>,
    execute: async (input, context) => {
      const snapshot = freeze(computerInputSchema.parse(input)) as OpenAIComputerCallInput;
      if (context && context.toolCall.providerMetadata?.responsesToolType !== "computer") throw new ConfigurationError("Computer executor requires a native OpenAI computer call.");
      if (context && snapshot.call_id !== context.toolCall.id) throw new ConfigurationError("Computer call identity mismatch.");
      const original = context?.toolCall.providerMetadata?.computerCallInput;
      if (context && (typeof original !== "string" || original !== JSON.stringify(snapshot))) throw new ConfigurationError("Computer actions or safety checks changed after provider generation.");
      context?.abortSignal?.throwIfAborted();
      const runtimeContext = { ...context, ...(context?.toolCall ? { toolCall: freeze(structuredClone(context.toolCall)) } : {}) };
      const executionContext = (abortSignal: AbortSignal): OpenAIComputerExecutionContext => ({ ...runtimeContext, abortSignal, deadline: Date.now() + timeout });
      const scope = context && (context as unknown as Record<symbol, object | undefined>)[Symbol.for("@zhivex-ai/core/tool-execution-scope")];
      let startedCalls = scope ? scopedCalls.get(scope) : inFlightCalls;
      if (!startedCalls) { startedCalls = new Set<string>(); scopedCalls.set(scope!, startedCalls); }
      const callKey = snapshot.call_id;
      const hasPriorResult = callKey && context?.request?.messages.some(message => message.parts.some(part => part.type === "tool-result" && part.toolResult.toolCallId === callKey));
      if (callKey && (startedCalls.has(callKey) || hasPriorResult)) throw new ConfigurationError("Computer call was already started; reconcile before retrying.");
      const checks = snapshot.pending_safety_checks ?? [];
      if (checks.length) {
        if (!snapshot.call_id || !config.approveSafetyChecks) throw new ConfigurationError("OpenAI computer pending safety checks require explicit approval.");
        const approved = await callback((abortSignal) => config.approveSafetyChecks!(snapshot, executionContext(abortSignal)), timeout, context?.abortSignal);
        if (approved !== true) throw new ConfigurationError("OpenAI computer safety approval denied.");
      }
      context?.abortSignal?.throwIfAborted();
      if (callKey && startedCalls.has(callKey)) throw new ConfigurationError("Computer call was already started; reconcile before retrying.");
      if (callKey) startedCalls.add(callKey);
      let enteredExecutor = false;
      try {
        const output = await callback(async (abortSignal) => {
          enteredExecutor = true;
          try { return await config.execute(snapshot, executionContext(abortSignal)); }
          finally {
            // An outer timeout cannot release a still-running direct executor.
            if (!scope && callKey) inFlightCalls.delete(callKey);
          }
        }, timeout, context?.abortSignal);
        const screenshot = computerScreenshotSchema.parse(output);
        return { ...screenshot, detail: "original", ...(snapshot.call_id ? { call_id: snapshot.call_id } : {}), ...(checks.length ? { acknowledged_safety_checks: checks } : {}) } as JsonValue;
      } catch (error) {
        throw new OpenAIComputerExecutionError(snapshot.call_id, error);
      } finally {
        if (!scope && callKey && !enteredExecutor) inFlightCalls.delete(callKey);
      }
    }
  };
};
