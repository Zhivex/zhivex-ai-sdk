import { constants, promises as fs } from "node:fs";
import path from "node:path";

import { redactTraceValue } from "./redact.js";

export interface JsonFileSpanExporterOptions {
  /** Destination JSONL file. Created with mode 0600. Symlinks are refused. */
  path: string;
}

export interface SpanExportResult {
  code: number;
  error?: Error;
}

/**
 * Minimal structural view of a finished OpenTelemetry span.
 * The SDK span object is not modified; this exporter only reads it.
 */
interface ExportableSpan {
  name?: unknown;
  kind?: unknown;
  spanContext?: (() => unknown) | unknown;
  parentSpanId?: unknown;
  parentSpanContext?: { spanId?: unknown } | unknown;
  startTime?: unknown;
  endTime?: unknown;
  startTimeUnixNano?: unknown;
  endTimeUnixNano?: unknown;
  attributes?: unknown;
  events?: unknown;
  status?: { code?: unknown; message?: unknown } | unknown;
}

const SUCCESS = 0;
const FAILED = 1;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const hrTimeToNano = (value: unknown): string | undefined => {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const seconds = value[0];
  const nanos = value[1];
  if (typeof seconds !== "number" || typeof nanos !== "number") return undefined;
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) return undefined;
  return (BigInt(Math.trunc(seconds)) * 1_000_000_000n + BigInt(Math.trunc(nanos))).toString();
};

const jsonSafe = (value: unknown): unknown => {
  if (typeof value === "string" || typeof value === "boolean" || value === null) return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((entry) => jsonSafe(entry));
  const record = asRecord(value);
  if (!record) return undefined;
  return Object.fromEntries(
    Object.entries(record)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, jsonSafe(entry)])
  );
};

const spanContextOf = (span: ExportableSpan): Record<string, unknown> => {
  const raw = typeof span.spanContext === "function" ? span.spanContext() : span.spanContext;
  return asRecord(raw) ?? {};
};

const serializeSpan = (span: ExportableSpan): Record<string, unknown> => {
  const context = spanContextOf(span);
  const parent = asRecord(span.parentSpanContext);
  const status = asRecord(span.status);
  const events = Array.isArray(span.events) ? span.events.flatMap((event) => {
    const record = asRecord(event);
    if (!record) return [];
    return [{
      name: record.name,
      timeUnixNano: hrTimeToNano(record.timeUnixNano) ?? hrTimeToNano(record.time),
      attributes: jsonSafe(record.attributes) ?? {}
    }];
  }) : [];
  return redactTraceValue({
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: span.parentSpanId ?? parent?.spanId,
    name: span.name,
    kind: span.kind,
    startTimeUnixNano: hrTimeToNano(span.startTimeUnixNano) ?? hrTimeToNano(span.startTime),
    endTimeUnixNano: hrTimeToNano(span.endTimeUnixNano) ?? hrTimeToNano(span.endTime),
    attributes: jsonSafe(span.attributes) ?? {},
    events,
    status: status ? { code: status.code, message: status.message } : undefined
  }) as Record<string, unknown>;
};

/**
 * Opt-in local JSONL exporter. Wire it into an OpenTelemetry processor yourself.
 * It does not change the SDK's default telemetry and it does not open a network socket.
 */
export const createJsonFileSpanExporter = (options: JsonFileSpanExporterOptions) => {
  const destination = path.resolve(options.path);
  let queue: Promise<void> = Promise.resolve();
  let closed = false;

  const writeLines = async (lines: string[]) => {
    if (lines.length === 0) return;
    const flags = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
    const handle = await fs.open(destination, flags, 0o600);
    try {
      await handle.appendFile(lines.join(""));
    } finally {
      await handle.close();
    }
  };

  const enqueue = (task: () => Promise<void>) => {
    const run = queue.then(task, task);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  return {
    export(spans: readonly object[], resultCallback: (result: SpanExportResult) => void): void {
      if (closed) {
        resultCallback({ code: FAILED, error: new Error("Span exporter is shut down.") });
        return;
      }
      enqueue(async () => {
        const lines = spans.map((span) => `${JSON.stringify(serializeSpan(span as ExportableSpan))}\n`);
        await writeLines(lines);
      }).then(
        () => resultCallback({ code: SUCCESS }),
        (error: unknown) => resultCallback({
          code: FAILED,
          error: error instanceof Error ? error : new Error("Failed to write spans.")
        })
      );
    },
    shutdown(): Promise<void> {
      closed = true;
      return queue;
    },
    forceFlush(): Promise<void> {
      return queue;
    }
  };
};
