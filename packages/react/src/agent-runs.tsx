"use client";
import type { AgentRunView } from "@zhivex-ai/core";
import type { HTMLAttributes, ReactNode } from "react";

export interface AgentRunsPanelProps extends HTMLAttributes<HTMLElement> {
  runs: readonly AgentRunView[];
  label?: string;
  labels?: { tokens?: string; tools?: string; steps?: string; handoff?: string };
  formatStatus?: (status: AgentRunView["status"]) => string;
  renderRun?: (run: AgentRunView) => ReactNode;
}

/** Run IDs, rather than agent names, distinguish concurrent invocations. */
export function AgentRunsPanel({ runs, label = "Agent executions", labels, formatStatus, renderRun, ...props }: AgentRunsPanelProps) {
  const unique = [...new Map(runs.slice(-200).map(run => [run.runId, run])).values()];
  const seen = new Set<string>();
  const children = new Map<string, AgentRunView[]>();
  for (const run of unique) {
    const key = run.parentRunId ?? "";
    children.set(key, [...(children.get(key) ?? []), run]);
  }
  const render = (run: AgentRunView, depth: number): ReactNode => {
    if (seen.has(run.runId) || depth > 32) return null;
    seen.add(run.runId);
    return <li key={run.runId} data-run-id={run.runId} data-status={run.status}>
      {renderRun ? renderRun(run) : <div className="zhivex-agent-run">
        <strong className="zhivex-agent-run__name">{run.name ?? run.agentId ?? run.runId}</strong>
        <span className="zhivex-agent-run__status">{formatStatus?.(run.status) ?? run.status.replaceAll("_", " ")}</span>
        <span>{labels?.steps ?? "Steps"}: {run.currentStep}/{run.maxSteps}</span>
        <span>{labels?.tokens ?? "Tokens"}: {run.usage?.totalTokens ?? "—"}{run.budget?.maxTotalTokens !== undefined ? ` / ${run.budget.maxTotalTokens}` : ""}</span>
        <span>{labels?.tools ?? "Tools"}: {run.toolCalls ?? "—"}{run.budget?.maxToolCalls !== undefined ? ` / ${run.budget.maxToolCalls}` : ""}</span>
        {run.handoffToAgentId ? <span>{labels?.handoff ?? "Handoff"}: {run.handoffToAgentId}</span> : null}
      </div>}
      {children.has(run.runId) ? <ul>{children.get(run.runId)!.map(child => render(child, depth + 1))}</ul> : null}
    </li>;
  };
  const ids = new Set(unique.map(run => run.runId));
  const roots = unique.filter(run => !run.parentRunId || !ids.has(run.parentRunId));
  return <section {...props} aria-label={props["aria-label"] ?? label} data-slot="agent-runs">
    <h3>{label}</h3><ul>{roots.map(run => render(run, 0))}{unique.filter(run => !seen.has(run.runId)).map(run => render(run, 0))}</ul>
  </section>;
}
