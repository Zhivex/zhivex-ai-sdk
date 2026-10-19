export interface TraceWarning {
  path: string;
  message: string;
}

export interface RawSpanEvent {
  name?: string;
  timeMs?: number;
  attributes: Record<string, unknown>;
}

/** Local projection of one finished OpenTelemetry span. Attribute names are unchanged. */
export interface RawSpan {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  startTimeMs?: number;
  endTimeMs?: number;
  attributes: Record<string, unknown>;
  events: RawSpanEvent[];
  statusCode?: number;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const nanoStringToMs = (value: string): number | undefined => {
  if (!/^\d+$/.test(value)) return undefined;
  try {
    return Number(BigInt(value) / 1_000_000n);
  } catch {
    return undefined;
  }
};

/** Accept OTLP nanoseconds, an `[seconds, nanos]` HrTime pair, or epoch milliseconds. */
export const timeToMs = (value: unknown, unit: "nano" | "hrtime" | "milli"): number | undefined => {
  if (unit === "milli") return asFiniteNumber(value);
  if (unit === "nano") {
    if (typeof value === "string") return nanoStringToMs(value);
    if (typeof value === "number" && Number.isFinite(value)) return value / 1_000_000;
    return undefined;
  }
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const seconds = asFiniteNumber(value[0]);
  const nanos = asFiniteNumber(value[1]);
  if (seconds === undefined || nanos === undefined) return undefined;
  return seconds * 1000 + nanos / 1_000_000;
};

const otlpAttributeValue = (value: unknown): unknown => {
  const record = asRecord(value);
  if (!record) return value;
  if ("stringValue" in record) return record.stringValue;
  if ("boolValue" in record) return record.boolValue;
  if ("doubleValue" in record) return record.doubleValue;
  if ("intValue" in record) {
    const intValue = record.intValue;
    if (typeof intValue === "number") return intValue;
    if (typeof intValue === "string" && /^-?\d+$/.test(intValue)) {
      const parsed = Number(intValue);
      return Number.isSafeInteger(parsed) ? parsed : intValue;
    }
    return intValue;
  }
  if ("arrayValue" in record) {
    const values = asRecord(record.arrayValue)?.values;
    return Array.isArray(values) ? values.map((entry) => otlpAttributeValue(entry)) : [];
  }
  return value;
};

export const normalizeAttributes = (value: unknown): Record<string, unknown> => {
  if (Array.isArray(value)) {
    const output: Record<string, unknown> = {};
    for (const entry of value) {
      const record = asRecord(entry);
      const key = record ? asString(record.key) : undefined;
      if (!record || !key) continue;
      output[key] = otlpAttributeValue(record.value);
    }
    return output;
  }
  const record = asRecord(value);
  if (!record) return {};
  return { ...record };
};

const eventTime = (record: Record<string, unknown>): number | undefined =>
  timeToMs(record.timeUnixNano, "nano")
  ?? timeToMs(record.time, "hrtime")
  ?? timeToMs(record.timestamp, "milli")
  ?? timeToMs(record.timeMs, "milli");

const normalizeEvents = (value: unknown): RawSpanEvent[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    if (!record) return [];
    return [{
      name: asString(record.name),
      timeMs: eventTime(record),
      attributes: normalizeAttributes(record.attributes)
    }];
  });
};

const isLedgerRecord = (value: unknown): boolean => {
  const record = asRecord(value);
  if (!record || typeof record.runId !== "string" || record.runId.length === 0) return false;
  if (record.type === "agent_run_ledger") return true;
  const audit = asRecord(record.audit);
  return record.type === undefined && audit?.type === "agent_run_audit";
};

const looksLikeSpan = (value: unknown): boolean => {
  const record = asRecord(value);
  if (!record || isLedgerRecord(record)) return false;
  const named = typeof record.name === "string";
  const identified = typeof record.traceId === "string" || typeof record.spanId === "string";
  const described = record.attributes !== undefined || Array.isArray(record.events);
  return (named && (identified || described)) || (identified && described);
};

/** Normalize one span object from flat JSONL or from an OTLP JSON span. */
export const normalizeSpan = (value: unknown): RawSpan | undefined => {
  const record = asRecord(value);
  if (!record || !looksLikeSpan(record)) return undefined;
  const parentContext = asRecord(record.parentSpanContext);
  const spanContext = asRecord(record.spanContext);
  const status = asRecord(record.status);
  return {
    traceId: asString(record.traceId) ?? asString(spanContext?.traceId),
    spanId: asString(record.spanId) ?? asString(spanContext?.spanId),
    parentSpanId: asString(record.parentSpanId) ?? asString(parentContext?.spanId),
    name: asString(record.name),
    startTimeMs: timeToMs(record.startTimeUnixNano, "nano")
      ?? timeToMs(record.startTime, "hrtime")
      ?? timeToMs(record.startTimeMs, "milli"),
    endTimeMs: timeToMs(record.endTimeUnixNano, "nano")
      ?? timeToMs(record.endTime, "hrtime")
      ?? timeToMs(record.endTimeMs, "milli"),
    attributes: normalizeAttributes(record.attributes),
    events: normalizeEvents(record.events),
    statusCode: asFiniteNumber(status?.code)
  };
};

const spansFromOtlp = (value: Record<string, unknown>): RawSpan[] => {
  const resourceSpans = Array.isArray(value.resourceSpans) ? value.resourceSpans : [];
  const spans: RawSpan[] = [];
  for (const resource of resourceSpans) {
    const scopeSpans = asRecord(resource)?.scopeSpans ?? asRecord(resource)?.instrumentationLibrarySpans;
    if (!Array.isArray(scopeSpans)) continue;
    for (const scope of scopeSpans) {
      const scopeRecord = asRecord(scope);
      const entries = scopeRecord?.spans;
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const span = normalizeSpan(entry);
        if (span) spans.push(span);
      }
    }
  }
  return spans;
};

export interface CollectedRecords {
  ledgers: unknown[];
  spans: RawSpan[];
  recognized: boolean;
}

/** Classify one JSON value as ledgers, spans, both, or unrecognized. */
export const collectTraceRecords = (value: unknown): CollectedRecords => {
  if (Array.isArray(value)) {
    if (value.length === 0) return { ledgers: [], spans: [], recognized: true };
    const ledgers: unknown[] = [];
    const spans: RawSpan[] = [];
    let recognized = false;
    for (const entry of value) {
      const collected = collectTraceRecords(entry);
      if (!collected.recognized) continue;
      recognized = true;
      ledgers.push(...collected.ledgers);
      spans.push(...collected.spans);
    }
    return { ledgers, spans, recognized };
  }

  const record = asRecord(value);
  if (!record) return { ledgers: [], spans: [], recognized: false };
  if (isLedgerRecord(record)) return { ledgers: [record], spans: [], recognized: true };
  if (record.type === "agent_golden_trace" && isLedgerRecord(record.ledger)) {
    return { ledgers: [record.ledger], spans: [], recognized: true };
  }
  if (Array.isArray(record.resourceSpans)) {
    const spans = spansFromOtlp(record);
    return { ledgers: [], spans, recognized: spans.length > 0 || record.resourceSpans.length === 0 };
  }
  if (Array.isArray(record.spans)) {
    const spans = record.spans.flatMap((entry) => {
      const span = normalizeSpan(entry);
      return span ? [span] : [];
    });
    const explicit = record.type === "zhivex_span_export" || record.type === undefined;
    return {
      ledgers: [],
      spans,
      recognized: explicit && (spans.length > 0 || record.spans.length === 0)
    };
  }
  const span = normalizeSpan(record);
  return span
    ? { ledgers: [], spans: [span], recognized: true }
    : { ledgers: [], spans: [], recognized: false };
};
