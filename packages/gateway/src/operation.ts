import { GatewayError } from "./types.js";
export class GatewayDeadlineError extends GatewayError {
  constructor() { super("Gateway operation deadline exceeded.", false); this.name = "GatewayDeadlineError"; }
}
export const operationControl = (parent?: AbortSignal, timeoutMs?: number) => {
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647)) throw new GatewayError("timeoutMs must be a positive timer-safe integer.", false);
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) abort();
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(new GatewayDeadlineError()), timeoutMs);
  const dispose = () => { clearTimeout(timer); parent?.removeEventListener("abort", abort); };
  return { signal: controller.signal, dispose,
    cancel: () => controller.abort(new DOMException("Gateway stream consumer closed.", "AbortError")),
    wait<T>(promise: Promise<T>): Promise<T> {
      return new Promise((resolve, reject) => {
        const stopped = () => { controller.signal.removeEventListener("abort", stopped); reject(controller.signal.reason); };
        promise.then(value => { controller.signal.removeEventListener("abort", stopped); resolve(value); }, error => { controller.signal.removeEventListener("abort", stopped); reject(error); });
        if (controller.signal.aborted) stopped();
        else controller.signal.addEventListener("abort", stopped, { once: true });
      });
    }
  };
};
