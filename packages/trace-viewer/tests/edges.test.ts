import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseTraceViewerArgs, runTraceViewerCli } from "../src/cli.js";
import { createJsonFileSpanExporter } from "../src/exporter.js";
import { renderTraceList, renderTraceRun } from "../src/page.js";
import { loadTraceView } from "../src/read.js";
import { redactTraceValue } from "../src/redact.js";
import { startTraceViewer } from "../src/server.js";
import { collectTraceRecords, normalizeSpan, timeToMs } from "../src/spans.js";
import { buildTraceView } from "../src/view.js";

const sample = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "sample");

describe("span document edges", () => {
  it("normalizes alternate time and OTLP shapes", () => {
    expect(timeToMs(12, "milli")).toBe(12);
    expect(timeToMs("nope", "nano")).toBeUndefined();
    expect(timeToMs(1_000_000, "nano")).toBe(1);
    expect(timeToMs([2, 500_000], "hrtime")).toBe(2000.5);
    expect(timeToMs([1], "hrtime")).toBeUndefined();
    expect(timeToMs("x", "milli")).toBeUndefined();

    const span = normalizeSpan({
      name: "chat model",
      spanContext: { traceId: "trace", spanId: "span" },
      parentSpanContext: { spanId: "parent" },
      startTime: [10, 0],
      endTimeUnixNano: "11000000000",
      attributes: { "zhivex.run_id": "run_alt" },
      events: [{ name: "approval-resolved", time: [10, 0], attributes: { "zhivex.approved": "allowed" } }, "skip"],
      status: { code: 0 }
    });
    expect(span?.traceId).toBe("trace");
    expect(span?.parentSpanId).toBe("parent");
    expect(span?.startTimeMs).toBe(10_000);
    expect(span?.events).toHaveLength(1);

    const otlp = collectTraceRecords({
      resourceSpans: [{
        instrumentationLibrarySpans: [{
          spans: [{
            name: "invoke_agent Alt",
            traceId: "t",
            spanId: "s",
            attributes: [
              { key: "zhivex.run_id", value: { stringValue: "run_lib" } },
              { key: "flag", value: { boolValue: true } },
              { key: "cost", value: { doubleValue: 1.5 } },
              { key: "big", value: { intValue: "9999999999999999999" } },
              { key: "labels", value: { arrayValue: { values: [{ stringValue: "a" }] } } },
              { value: { stringValue: "missing-key" } }
            ],
            events: []
          }]
        }]
      }]
    });
    expect(otlp.spans[0]?.attributes["zhivex.run_id"]).toBe("run_lib");
    expect(otlp.spans[0]?.attributes.flag).toBe(true);
    expect(otlp.spans[0]?.attributes.labels).toEqual(["a"]);

    expect(collectTraceRecords([]).recognized).toBe(true);
    expect(collectTraceRecords({ resourceSpans: [] }).recognized).toBe(true);
    expect(collectTraceRecords({ type: "zhivex_span_export", spans: [] }).recognized).toBe(true);
    expect(collectTraceRecords({ type: "agent_golden_trace", ledger: { hello: true } }).recognized).toBe(false);
    expect(collectTraceRecords([
      { type: "agent_run_ledger", runId: "run_in_array", audit: { type: "agent_run_audit" } },
      { name: "chat nested", traceId: "tt", spanId: "ss", attributes: {} }
    ]).ledgers).toHaveLength(1);
    expect(normalizeSpan({ name: "not-quite" })).toBeUndefined();
    expect(collectTraceRecords("nope").recognized).toBe(false);
  });
});

describe("reader edges", () => {
  it("reports jsonl problems, skips deep files, and does not double-read one path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zhivex-trace-edges-"));
    await writeFile(path.join(root, "notes.txt"), "ignore");
    await writeFile(path.join(root, "lines.jsonl"), [
      "{",
      JSON.stringify({ hello: true }),
      JSON.stringify({
        name: "chat line",
        traceId: "t",
        spanId: "s",
        attributes: { "zhivex.run_id": "run_line", "gen_ai.usage.input_tokens": 2 }
      })
    ].join("\n"));
    let deep = root;
    for (const name of ["a", "b", "c", "d", "e"]) {
      deep = path.join(deep, name);
      await mkdir(deep);
    }
    await writeFile(path.join(deep, "hidden.json"), JSON.stringify({
      type: "agent_run_ledger",
      runId: "run_too_deep"
    }));
    const limited = await mkdtemp(path.join(tmpdir(), "zhivex-trace-many-"));
    await Promise.all(Array.from({ length: 501 }, (_, index) => writeFile(
      path.join(limited, `run-${index}.json`),
      JSON.stringify({ type: "agent_run_ledger", runId: `run_many_${index}`, audit: { type: "agent_run_audit" } })
    )));

    const view = await loadTraceView({ ledgerPath: root, spansPath: path.join(root, "lines.jsonl") });
    expect(view.runs.some((run) => run.runId === "run_line")).toBe(true);
    expect(view.runs.some((run) => run.runId === "run_too_deep")).toBe(false);
    const messages = view.warnings.map((warning) => warning.message);
    expect(messages.some((message) => message.startsWith("Invalid JSON"))).toBe(true);
    expect(messages.some((message) => message.startsWith("Unrecognized"))).toBe(true);
    expect(messages).toContain("Directory depth limit reached.");

    const capped = await loadTraceView({ ledgerPath: limited });
    expect(capped.runs).toHaveLength(500);
    expect(capped.warnings.map((warning) => warning.message)).toContain("File limit reached; some inputs were skipped.");

    const text = await loadTraceView({ ledgerPath: path.join(root, "notes.txt") });
    expect(text.warnings.map((warning) => warning.message)).toContain("Unsupported file type. Use .json or .jsonl.");

    const once = await loadTraceView({ ledgerPath: sample });
    const twice = await loadTraceView({ ledgerPath: sample, spansPath: sample });
    expect(twice.runs).toHaveLength(once.runs.length);
    await expect(loadTraceView({ ledgerPath: path.join(root, "missing") })).rejects.toThrow(/does not exist/);
  });
});

describe("view edges", () => {
  it("merges timeline tools, partial cost, and span failures", () => {
    const view = buildTraceView({
      ledgers: [{
        type: "agent_run_ledger",
        runId: "run_timeline",
        status: "completed",
        cost: { inputCost: 0.1, outputCost: 0.2, currency: "USD" },
        trace: {
          steps: [{
            index: 0,
            status: "completed",
            startedAt: 10,
            finishedAt: 40,
            toolCalls: [{ id: "c1", name: "lookup" }],
            toolResults: [{ toolCallId: "c1", toolName: "lookup", isError: true, error: { message: "nope" } }],
            usage: { inputTokens: 1, outputTokens: 4, totalTokens: 5, cachedInputTokens: 2, reasoningTokens: 3 }
          }]
        },
        timeline: [
          { type: "tool-call", step: 0, toolCall: { id: "c2", name: "other", input: { q: "x" } } },
          { type: "tool-result", step: 0, result: { toolCallId: "c2", toolName: "other", isError: false, output: { ok: true } } },
          { type: "approval-request", approval: { id: "apr_t", name: "other", userId: "sam" } },
          { type: "ignored" }
        ],
        toolAudit: [{
          toolCallId: "c1",
          toolName: "lookup",
          step: 0,
          status: "failed",
          input: null,
          error: { message: "nope" }
        }]
      }],
      spans: [
        {
          name: "app.step",
          spanId: "s1",
          startTimeMs: 1,
          endTimeMs: 9,
          attributes: { "zhivex.run_id": "run_span_step", "zhivex.step_index": 1, "zhivex.step_status": "failed" },
          events: [{
            name: "tool-start",
            timeMs: 5,
            attributes: { "gen_ai.tool.name": "ping", "gen_ai.tool.call.id": "p1", "zhivex.step_index": 1 }
          }, {
            name: "approval-resolved",
            timeMs: 6,
            attributes: { "zhivex.approval_id": "apr_span", "zhivex.approved": "denied", "zhivex.approver": "sam" }
          }]
        },
        {
          name: "execute_tool ping",
          spanId: "s2",
          parentSpanId: "s1",
          statusCode: 2,
          attributes: {
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": "ping",
            "gen_ai.tool.call.id": "p1",
            "zhivex.tool_error": true
          },
          events: []
        }
      ]
    });
    const timeline = view.runs.find((run) => run.runId === "run_timeline");
    expect(timeline?.cost).toBe("0.3 USD");
    expect(timeline?.steps[0]?.durationMs).toBe(30);
    expect(timeline?.steps[0]?.usage).toContain("cached");
    expect(timeline?.steps[0]?.usage).toContain("reasoning");
    expect(timeline?.toolCalls.find((tool) => tool.id === "c1")).toMatchObject({
      arguments: "omitted",
      result: "nope",
      status: "failed"
    });
    expect(timeline?.toolCalls.find((tool) => tool.id === "c2")?.arguments).toContain("\"q\":\"x\"");
    expect(timeline?.approvals[0]).toMatchObject({ what: "other", who: "sam", decision: "pending" });

    const spanRun = view.runs.find((run) => run.runId === "run_span_step");
    expect(spanRun?.steps[0]).toMatchObject({ index: 1, status: "failed", toolCallCount: 1 });
    expect(spanRun?.toolCalls[0]?.status).toBe("failed");
    expect(spanRun?.approvals[0]).toMatchObject({ decision: "denied", who: "sam" });

    const empty = buildTraceView({ ledgers: [{ type: "agent_run_ledger", runId: "run_empty" }] });
    expect(renderTraceRun(empty, empty.runs[0]!)).toContain("No steps were recorded.");
    expect(renderTraceRun(empty, empty.runs[0]!)).toContain("No tool calls were recorded.");
    expect(renderTraceRun(empty, empty.runs[0]!)).toContain("No approvals were recorded.");
    expect(renderTraceList({ runs: [], warnings: [] })).toContain("No runs were found.");
  });
});

describe("redaction limits", () => {
  it("caps depth, width, and non-finite values", () => {
    let deep: unknown = "x";
    for (let index = 0; index < 25; index += 1) deep = [deep];
    expect(JSON.stringify(redactTraceValue(deep))).toContain("[truncated]");
    const wide = redactTraceValue(new Array(201).fill("ok")) as unknown[];
    expect(wide.at(-1)).toBe("[truncated]");
    const keys = Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`k${index}`, 1]));
    expect(redactTraceValue(keys)).toHaveProperty("[truncated]", true);
    expect(redactTraceValue(1n)).toBe("1");
    expect(redactTraceValue(Number.NaN)).toBeNull();
    expect(redactTraceValue(() => undefined)).toBeNull();
    expect(String(redactTraceValue(`${"a".repeat(100_001)}`))).toContain("...");
  });
});

describe("exporter and server edges", () => {
  it("flushes, rejects a missing directory, and refuses bad ports and methods", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zhivex-trace-export-edge-"));
    const exporter = createJsonFileSpanExporter({ path: path.join(root, "spans.jsonl") });
    await new Promise<void>((resolve, reject) => {
      exporter.export([{
        name: "invoke_agent Edge",
        kind: 0,
        spanContext: () => ({ traceId: "t", spanId: "s" }),
        startTimeUnixNano: "1000000000",
        attributes: { "zhivex.run_id": "run_edge", count: 1n, bad: Number.POSITIVE_INFINITY, skip: undefined },
        events: [null, { name: "note", timeUnixNano: "1000000000", attributes: { ok: true } }],
        status: { code: 0 }
      }], (result) => result.error ? reject(result.error) : resolve());
    });
    await exporter.forceFlush();
    const missing = createJsonFileSpanExporter({ path: path.join(root, "missing", "spans.jsonl") });
    const failed = await new Promise<number>((resolve) => {
      missing.export([{ name: "invoke_agent Missing", attributes: {} }], (result) => resolve(result.code));
    });
    expect(failed).toBe(1);

    await expect(startTraceViewer({ ledgerPath: sample, port: -1 })).rejects.toThrow(/Invalid port/);
    const viewer = await startTraceViewer({ ledgerPath: sample, port: 0 });
    try {
      const denied = await fetch(viewer.url, { method: "POST" });
      expect(denied.status).toBe(405);
      const missingPage = await fetch(`${viewer.url}nope`);
      expect(missingPage.status).toBe(404);
    } finally {
      await viewer.close();
    }

    expect(parseTraceViewerArgs(["--version"]).version).toBe(true);
    expect(parseTraceViewerArgs(["--host=localhost", "--ledger=runs"]).host).toBe("127.0.0.1");
    expect(await runTraceViewerCli(["--version"], "0.1.0")).toBe(0);
    expect(await runTraceViewerCli(["--port", "nope"])).toBe(1);
    expect(await runTraceViewerCli(["--nope"])).toBe(1);
    expect(await runTraceViewerCli(["--ledger"])).toBe(1);
    expect(await runTraceViewerCli(["--ledger", sample, "--port", "0"], "0.1.0", async () => undefined)).toBe(0);
  });
});
