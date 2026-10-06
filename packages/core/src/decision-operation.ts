import { ProviderHTTPError, ValidationError } from './errors.js';
import { withTimeoutSignal } from './runtime.js';
import type { DecisionInput } from './decisions.js';

/** Bounds settlement even for custom transports that ignore abort. Never retains input/error causes. */
export async function decisionOperation<T>(input: Pick<DecisionInput, 'abortSignal' | 'timeoutMs'>, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const control = withTimeoutSignal({ abortSignal: input.abortSignal, timeoutMs: input.timeoutMs ?? 30000 });
  const aborted = () => new DOMException('Decision operation cancelled or timed out.', input.abortSignal?.aborted ? 'AbortError' : 'TimeoutError');
  let onAbort: () => void = () => {};
  try {
    if (control.signal.aborted) throw aborted();
    const cancellation = new Promise<never>((_, reject) => {
      onAbort = () => reject(aborted());
      control.signal.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([operation(control.signal), cancellation]);
  } catch (error) {
    if (control.signal.aborted) throw aborted();
    if (error instanceof ProviderHTTPError) throw new ProviderHTTPError(`Decision request failed (${error.status}).`, error.status);
    if (error instanceof ValidationError) throw new ValidationError('Invalid experimental decision request or response.');
    throw new Error('Decision operation failed.');
  } finally {
    control.signal.removeEventListener('abort', onAbort);
    control.cleanup();
  }
}
