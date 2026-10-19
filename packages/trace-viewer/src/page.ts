import type { TraceRunView, TraceView } from "./view.js";

const escapeHtml = (value: string): string => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

const text = (value: string | number | undefined, fallback = "—"): string =>
  value === undefined || value === "" ? fallback : escapeHtml(String(value));

const STYLES = `
:root { color-scheme: light dark; --ink: #1c1917; --muted: #57534e; --line: #e7e5e4; --bg: #fafaf9; --card: #fff; --ok: #166534; --no: #991b1b; --wait: #92400e; --link: #1d4ed8; }
@media (prefers-color-scheme: dark) {
  :root { --ink: #f5f5f4; --muted: #a8a29e; --line: #44403c; --bg: #1c1917; --card: #292524; --ok: #86efac; --no: #fca5a5; --wait: #fdba74; --link: #93c5fd; }
}
body { margin: 0; font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; color: var(--ink); background: var(--bg); }
header, main { max-width: 1100px; margin: 0 auto; padding: 24px; }
header { padding-bottom: 0; }
h1 { font-size: 1.45rem; margin: 0 0 4px; }
h2 { font-size: 1.05rem; margin: 0 0 8px; }
a { color: var(--link); }
.muted { color: var(--muted); }
.banner, .warn, table { background: var(--card); border: 1px solid var(--line); }
.banner, .warn { padding: 12px 14px; margin: 16px 0; }
.warn { border-color: #fdba74; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; vertical-align: top; border-bottom: 1px solid var(--line); padding: 8px 10px; }
th { font-size: 0.75rem; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
pre { white-space: pre-wrap; word-break: break-word; margin: 0; font: 12px/1.45 ui-monospace, SFMono-Regular, monospace; }
.approved { color: var(--ok); font-weight: 650; }
.denied { color: var(--no); font-weight: 650; }
.pending { color: var(--wait); font-weight: 650; }
section { margin-top: 28px; }
footer { max-width: 1100px; margin: 0 auto; padding: 0 24px 32px; color: var(--muted); font-size: 0.85rem; }
`;

const documentPage = (title: string, body: string): string => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
${body}
<footer>Local only. This page does not send ledger or span data anywhere.</footer>
</body>
</html>
`;

const warningsBlock = (view: TraceView): string => {
  if (view.warnings.length === 0) return "";
  const items = view.warnings.map((warning) =>
    `<li>${escapeHtml(warning.path)}: ${escapeHtml(warning.message)}</li>`
  ).join("");
  return `<div class="warn"><strong>Input warnings</strong><ul>${items}</ul></div>`;
};

const runHref = (runId: string): string => `/run?id=${encodeURIComponent(runId)}`;

const summaryRow = (run: TraceRunView): string => `<tr data-run="${escapeHtml(run.runId)}">
<td><a href="${runHref(run.runId)}">${escapeHtml(run.runId)}</a></td>
<td>${text(run.status)}</td>
<td>${text([run.provider, run.modelId].filter(Boolean).join(" / "))}</td>
<td>${run.stepCount}</td>
<td>${run.toolCalls.length}</td>
<td>${run.approvals.length}</td>
<td>${text(run.usage)}</td>
<td>${text(run.cost)}</td>
</tr>`;

/** Render the run list. */
export const renderTraceList = (view: TraceView): string => {
  const rows = view.runs.length > 0
    ? view.runs.map(summaryRow).join("")
    : `<tr><td colspan="8">No runs were found.</td></tr>`;
  return documentPage("Zhivex trace viewer", `
<header>
  <h1>Zhivex trace viewer</h1>
  <p class="muted">Read-only view of saved governance ledgers and OpenTelemetry spans.</p>
</header>
<main>
  <div class="banner">Bound to loopback. Restart the command to reload files.</div>
  ${warningsBlock(view)}
  <table>
    <thead><tr><th>Run</th><th>Status</th><th>Model</th><th>Steps</th><th>Tools</th><th>Approvals</th><th>Tokens</th><th>Cost</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</main>`);
};

const stepRows = (run: TraceRunView): string => {
  if (run.stepDetail === "count-only") {
    return `<p>${run.stepCount} steps were recorded without per-step detail.</p>`;
  }
  if (run.steps.length === 0) return `<p>No steps were recorded.</p>`;
  const rows = run.steps.map((step) => `<tr>
<td>${step.index}</td>
<td>${text(step.status)}</td>
<td>${text(step.startedAt)}</td>
<td>${text(step.finishedAt)}</td>
<td>${text(step.durationMs)}</td>
<td>${step.toolCallCount}</td>
<td>${text(step.usage)}</td>
</tr>`).join("");
  return `<table>
<thead><tr><th>Step</th><th>Status</th><th>Started</th><th>Finished</th><th>Duration ms</th><th>Tools</th><th>Tokens</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
};

const toolRows = (run: TraceRunView): string => {
  if (run.toolCalls.length === 0) return `<p>No tool calls were recorded.</p>`;
  return `<table>
<thead><tr><th>Tool</th><th>Call</th><th>Step</th><th>Status</th><th>Arguments</th><th>Result</th></tr></thead>
<tbody>${run.toolCalls.map((tool) => `<tr data-tool="${escapeHtml(tool.id ?? tool.name)}">
<td>${escapeHtml(tool.name)}</td>
<td>${text(tool.id)}</td>
<td>${text(tool.step)}</td>
<td>${text(tool.status)}</td>
<td><pre>${escapeHtml(tool.arguments)}</pre></td>
<td><pre>${escapeHtml(tool.result)}</pre></td>
</tr>`).join("")}</tbody>
</table>`;
};

const approvalRows = (run: TraceRunView): string => {
  if (run.approvals.length === 0) return `<p>No approvals were recorded.</p>`;
  return `<table>
<thead><tr><th>What</th><th>Who</th><th>When</th><th>Decision</th><th>Reason</th></tr></thead>
<tbody>${run.approvals.map((approval) => `<tr data-approval="${escapeHtml(approval.id ?? approval.what)}">
<td>${escapeHtml(approval.what)}</td>
<td>${escapeHtml(approval.who)}</td>
<td>${text(approval.when)}</td>
<td class="${approval.decision}">${escapeHtml(approval.decision)}</td>
<td>${text(approval.reason)}</td>
</tr>`).join("")}</tbody>
</table>`;
};

/** Render one run. */
export const renderTraceRun = (view: TraceView, run: TraceRunView): string => documentPage(run.runId, `
<header>
  <p><a href="/">All runs</a></p>
  <h1>${escapeHtml(run.runId)}</h1>
  <p class="muted">${text(run.status, "unknown status")} · ${text([run.provider, run.modelId].filter(Boolean).join(" / "), "model not recorded")}${run.agentId ? ` · ${escapeHtml(run.agentId)}` : ""}</p>
</header>
<main>
  ${warningsBlock(view)}
  <section>
    <h2>Usage and cost</h2>
    <p>Tokens: ${text(run.usage, "not recorded")}</p>
    <p>Cost: ${text(run.cost, "not recorded")}</p>
    <p>Started: ${text(run.startedAt, "not recorded")}</p>
    <p>Updated: ${text(run.updatedAt, "not recorded")}</p>
  </section>
  <section><h2>Steps</h2>${stepRows(run)}</section>
  <section><h2>Tool calls</h2>${toolRows(run)}</section>
  <section><h2>Approvals</h2>${approvalRows(run)}</section>
</main>`);

/** Render a missing-run page. */
export const renderMissingRun = (view: TraceView, runId: string): string => documentPage("Run not found", `
<header>
  <p><a href="/">All runs</a></p>
  <h1>Run not found</h1>
</header>
<main>
  <p>No loaded run matches <code>${escapeHtml(runId)}</code>.</p>
  ${warningsBlock(view)}
</main>`);
