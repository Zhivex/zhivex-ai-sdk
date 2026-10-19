import { promises as fs } from "node:fs";
import { mkdtemp, mkdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseTraceViewerArgs, runTraceViewerCli } from "../src/cli.js";
import { createJsonFileSpanExporter } from "../src/exporter.js";
import { loadTraceView } from "../src/read.js";
import { isSensitiveKey, redactTraceValue, REDACTED } from "../src/redact.js";
import { renderTraceRun } from "../src/page.js";
import { resolveLoopbackHost, startTraceViewer } from "../src/server.js";
import { buildTraceView, formatTimestamp } from "../src/view.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const sample = path.join(fixtures, "sample");
const secrets = [
  "fixture-token-value",
  "fixture-api-key-value",
  "fixturetokenvalue",
  "fixturekeyvalue",
  "ada@example.com",
  "TAIL_MARKER"
];

describe("redaction", () => {
  it("redacts SDK-sensitive keys and text without touching usage fields", () => {
    expect(isSensitiveKey("apiKey")).toBe(true);
    expect(isSensitiveKey("api_key")).toBe(true);
    expect(isSensitiveKey("x-api-key")).toBe(true);
    expect(isSensitiveKey("Authorization")).toBe(true);
    expect(isSensitiveKey("approvalToken")).toBe(true);
    expect(isSensitiveKey("set-cookie")).toBe(true);
    expect(isSensitiveKey("password")).toBe(true);
    expect(isSensitiveKey("inputTokens")).toBe(false);
    expect(isSensitiveKey("totalTokens")).toBe(false);
    expect(isSensitiveKey("runId")).toBe(false);

    const redacted = redactTraceValue({
      orderId: "1001",
      apiKey: "fixture-api-key-value",
      authorization: "Bearer fixture-token-value",
      note: "prefix token=fixturetokenvalue suffix",
      headers: { Authorization: "Basic fixture-basic-value" },
      email: "ada@example.com",
      inputTokens: 12
    }) as Record<string, unknown>;

    expect(redacted.orderId).toBe("1001");
    expect(redacted.apiKey).toBe(REDACTED);
    expect(redacted.authorization).toBe(REDACTED);
    expect(redacted.note).toBe(`prefix ${REDACTED} suffix`);
    expect(redacted.headers).toEqual({ Authorization: REDACTED });
    expect(redacted.email).toBe(REDACTED);
    expect(redacted.inputTokens).toBe(12);
    expect(JSON.stringify(redacted)).not.toContain("fixture-api-key-value");
    expect(JSON.stringify(redacted)).not.toContain("fixture-token-value");
    expect(JSON.stringify(redacted)).not.toContain("ada@example.com");
  });
});

describe("fixture ledgers and spans", () => {
  it("loads runs, joins spans, and keeps corrupt input as warnings", async () => {
    const view = await loadTraceView({ ledgerPath: sample });
    const messages = view.warnings.map((warning) => warning.message);
    expect(messages).toContain("Invalid JSON.");
    expect(messages).toContain("Empty file.");
    expect(messages).toContain("Unrecognized trace file.");
    expect(messages).toContain("1 span(s) had no zhivex.run_id and were skipped.");

    const fixture = view.runs.find((run) => run.runId === "run_fixture_1");
    expect(fixture).toMatchObject({
      status: "completed",
      provider: "openai",
      modelId: "gpt-6-astra",
      stepCount: 2,
      stepDetail: "recorded",
      usage: "120 in / 40 out / 160 total",
      cost: "0.002 USD"
    });
    expect(fixture?.steps.map((step) => step.index)).toEqual([0, 1]);
    expect(fixture?.toolCalls).toHaveLength(1);
    expect(fixture?.toolCalls[0]).toMatchObject({
      id: "call_lookup",
      name: "lookup<script>",
      step: 0,
      status: "completed"
    });
    expect(fixture?.toolCalls[0]?.arguments).toContain("1001");
    expect(fixture?.toolCalls[0]?.arguments.endsWith("...")).toBe(true);
    expect(fixture?.toolCalls[0]?.result).toContain("shipped");
    expect(fixture?.toolCalls[0]?.result).toContain(REDACTED);
    for (const secret of secrets) {
      expect(JSON.stringify(fixture)).not.toContain(secret);
    }
    expect(fixture?.usage).not.toContain("999");

    const publish = fixture?.approvals.find((approval) => approval.id === "apr_1");
    expect(publish).toMatchObject({
      what: "publish",
      who: "not recorded",
      decision: "approved",
      reason: "owner accepted",
      when: formatTimestamp(1760000003000)
    });
    const deploy = fixture?.approvals.find((approval) => approval.id === "call_deploy");
    expect(deploy).toMatchObject({
      what: "deploy",
      who: "casey",
      decision: "denied",
      when: formatTimestamp(1760000001500)
    });
    const refund = fixture?.approvals.find((approval) => approval.id === "apr_pending");
    expect(refund).toMatchObject({ what: "refund", who: "not recorded", decision: "pending" });

    const spansOnly = view.runs.find((run) => run.runId === "run_spans_only");
    expect(spansOnly).toMatchObject({
      provider: "ollama",
      modelId: "fixture-local",
      usage: "5 in / 2 out",
      stepDetail: "recorded"
    });
    expect(spansOnly?.steps[0]).toMatchObject({ index: 0, status: "completed", toolCallCount: 1 });
    expect(spansOnly?.toolCalls[0]).toMatchObject({
      id: "call_shell",
      name: "shell",
      arguments: "omitted",
      result: "omitted"
    });
    expect(spansOnly?.approvals[0]).toMatchObject({
      what: "shell",
      who: "not recorded",
      decision: "denied"
    });

    const otlp = view.runs.find((run) => run.runId === "run_otlp");
    expect(otlp).toMatchObject({ provider: "gemini", usage: "9 in / 4 out" });
    expect(otlp?.approvals[0]).toMatchObject({
      what: "charge",
      who: "mina",
      decision: "denied"
    });

    expect(view.runs.some((run) => run.runId === "run_golden")).toBe(true);
    expect(view.runs.some((run) => run.runId === "orphan-model")).toBe(false);
  });

  it("accepts an empty directory and a corrupt file without throwing", async () => {
    const empty = await loadTraceView({ ledgerPath: path.join(fixtures, "empty") });
    expect(empty.runs).toEqual([]);
    expect(empty.warnings.map((warning) => warning.message)).toContain("No ledger or span files.");

    const directory = await mkdtemp(path.join(tmpdir(), "zhivex-trace-corrupt-"));
    const input = path.join(directory, "input");
    await mkdir(input);
    await writeFile(path.join(input, "broken.json"), "{");
    await writeFile(path.join(input, "huge.json"), `{${" ".repeat(8 * 1024 * 1024)}`);
    const linkTarget = path.join(directory, "secret.json");
    await writeFile(linkTarget, JSON.stringify({
      type: "agent_run_ledger",
      runId: "run_secret_link",
      outputText: "Bearer fixture-token-value"
    }));
    await symlink(linkTarget, path.join(input, "linked.json"));
    const view = await loadTraceView({ ledgerPath: input });
    expect(view.runs).toEqual([]);
    const messages = view.warnings.map((warning) => warning.message);
    expect(messages).toContain("Invalid JSON.");
    expect(messages).toContain("File exceeds 8 MiB and was skipped.");
    expect(messages).toContain("Refusing to follow a symlink.");
    expect(JSON.stringify(view)).not.toContain("fixture-token-value");
    expect(JSON.stringify(view)).not.toContain("run_secret_link");
  });

  it("reads a legacy ledger and a count-only ledger", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "zhivex-trace-legacy-"));
    await writeFile(path.join(directory, "legacy.json"), JSON.stringify({
      runId: "run_legacy",
      provider: "openai",
      modelId: "gpt-6-astra",
      status: "completed",
      audit: { type: "agent_run_audit", steps: 4, usage: { inputTokens: 3, outputTokens: 1 } },
      toolAudit: []
    }));
    const view = await loadTraceView({ ledgerPath: directory });
    expect(view.runs[0]).toMatchObject({
      runId: "run_legacy",
      stepCount: 4,
      stepDetail: "count-only",
      usage: "3 in / 1 out"
    });
  });

  it("keeps a suspended approval pending and redacts the approver email", () => {
    const view = buildTraceView({
      ledgers: [{
        type: "agent_run_ledger",
        runId: "run_hold",
        trace: {
          events: [{
            type: "tool-approval",
            timestamp: 1760000000000,
            data: {
              toolCall: { id: "call_hold", name: "write" },
              approved: false,
              metadata: { approvalRequired: true, approver: "ada@example.com" }
            }
          }]
        }
      }]
    });
    expect(view.runs[0]?.approvals[0]).toMatchObject({
      what: "write",
      who: REDACTED,
      decision: "pending"
    });
  });
});

describe("json span exporter", () => {
  it("appends redacted JSONL and the viewer can read it back", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "zhivex-trace-export-"));
    const file = path.join(directory, "spans.jsonl");
    const exporter = createJsonFileSpanExporter({ path: file });
    await new Promise<void>((resolve, reject) => {
      exporter.export([{
        name: "invoke_agent Fixture",
        kind: 0,
        spanContext: () => ({ traceId: "aa", spanId: "bb" }),
        startTime: [1_760_000_030, 0],
        endTime: [1_760_000_031, 0],
        attributes: {
          "zhivex.run_id": "run_export",
          "zhivex.provider": "openai",
          authorization: "Bearer fixture-token-value",
          note: "token=fixturetokenvalue"
        },
        events: [{
          name: "approval-resolved",
          time: [1_760_000_030, 500_000_000],
          attributes: {
            "zhivex.approval_id": "apr_export",
            "zhivex.approval_name": "ship",
            "zhivex.approved": true
          }
        }],
        status: { code: 0 }
      }], (result) => result.error ? reject(result.error) : resolve());
    });
    const written = await fs.readFile(file, "utf8");
    expect(written).toContain("run_export");
    expect(written).toContain(REDACTED);
    expect(written).not.toContain("fixture-token-value");
    expect(written).not.toContain("fixturetokenvalue");
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const view = await loadTraceView({ ledgerPath: file });
    expect(view.runs[0]).toMatchObject({
      runId: "run_export",
      provider: "openai"
    });
    expect(view.runs[0]?.approvals[0]).toMatchObject({
      what: "ship",
      decision: "approved",
      who: "not recorded"
    });

    await exporter.shutdown();
    const afterShutdown = await new Promise<number>((resolve) => {
      exporter.export([], (result) => resolve(result.code));
    });
    expect(afterShutdown).toBe(1);

    const link = path.join(directory, "linked.jsonl");
    await symlink(file, link);
    const linked = createJsonFileSpanExporter({ path: link });
    const linkResult = await new Promise<{ code: number }>((resolve) => {
      linked.export([{ name: "invoke_agent Again", attributes: { "zhivex.run_id": "run_link" } }], resolve);
    });
    expect(linkResult.code).toBe(1);
  });
});

describe("local server", () => {
  it("serves the fixture view on 127.0.0.1 and escapes tool names", async () => {
    const viewer = await startTraceViewer({ ledgerPath: sample, host: "127.0.0.1", port: 0 });
    try {
      expect(viewer.host).toBe("127.0.0.1");
      expect(viewer.url.startsWith("http://127.0.0.1:")).toBe(true);
      const list = await fetch(viewer.url);
      expect(list.status).toBe(200);
      expect(list.headers.get("content-security-policy")).toContain("default-src 'none'");
      const listHtml = await list.text();
      expect(listHtml).toContain("run_fixture_1");
      expect(listHtml).toContain("0.002 USD");
      expect(listHtml).not.toContain("No runs were found.");
      for (const secret of secrets) expect(listHtml).not.toContain(secret);
      expect(listHtml).not.toMatch(/https?:\/\//);

      const detail = await fetch(`${viewer.url}run?id=${encodeURIComponent("run_fixture_1")}`);
      const detailHtml = await detail.text();
      expect(detailHtml).toContain("lookup&lt;script&gt;");
      expect(detailHtml).not.toContain("<script>");
      expect(detailHtml).toContain("casey");
      expect(detailHtml).toContain("approved");
      expect(detailHtml).toContain("denied");
      expect(detailHtml).toContain("pending");
      expect(detailHtml).toContain("not recorded");
      for (const secret of secrets) expect(detailHtml).not.toContain(secret);

      const missing = await fetch(`${viewer.url}run?id=missing`);
      expect(missing.status).toBe(404);
      const head = await fetch(viewer.url, { method: "HEAD" });
      expect(head.status).toBe(200);
    } finally {
      await viewer.close();
    }
  });

  it("refuses a non-loopback host", () => {
    expect(resolveLoopbackHost(undefined)).toBe("127.0.0.1");
    expect(resolveLoopbackHost("localhost")).toBe("127.0.0.1");
    expect(resolveLoopbackHost("::1")).toBe("::1");
    expect(() => resolveLoopbackHost("0.0.0.0")).toThrow(/127\.0\.0\.1/);
    expect(() => parseTraceViewerArgs(["--host", "10.0.0.8", "--ledger", "ledger.json"])).toThrow(/127\.0\.0\.1/);
  });

  it("parses the CLI and does not listen for help", async () => {
    expect(parseTraceViewerArgs(["--ledger", "runs", "--spans=spans.jsonl", "--port", "9473"])).toMatchObject({
      ledgerPath: "runs",
      spansPath: "spans.jsonl",
      host: "127.0.0.1",
      port: 9473
    });
    expect(await runTraceViewerCli(["--help"])).toBe(0);
    expect(await runTraceViewerCli([])).toBe(1);
    expect(await runTraceViewerCli(["--ledger", path.join(tmpdir(), "missing-zhivex-ledger")])).toBe(1);
  });
});

describe("rendered page", () => {
  it("describes a count-only step list", () => {
    const view = buildTraceView({
      ledgers: [{
        type: "agent_run_ledger",
        runId: "run_count",
        status: "completed",
        summary: { steps: 4 }
      }]
    });
    expect(renderTraceRun(view, view.runs[0]!)).toContain("4 steps were recorded without per-step detail.");
  });
});
