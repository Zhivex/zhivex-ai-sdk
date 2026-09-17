// Derived from ZHX-EXP-001 v0.3; original baseline remains unchanged.
import {readFile, writeFile} from 'node:fs/promises';
import {decide} from './fixture';
import { reconcileAgentToolExecution, createAgent, createFileAgentRunStore, createTextMessage, normalizeAgentRunState, runAgent, resumeAgent, tool } from '@zhivex-ai/core';
import { z } from 'zod';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
const [directory, service, caseId, mode] = process.argv.slice(2);
const config = JSON.parse(await readFile(join(directory, 'case.json'), 'utf8'));
const store = createFileAgentRunStore({ directory: join(directory, 'store') });
const emit = (data: any) => console.log(JSON.stringify({ ...data, pid: process.pid }));
const request = async (method: string, body?: any) => {
  const response = await fetch(`${service}/${caseId}`, { method, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result;
};
const model: any = {
  provider: 'fixture', modelId: 'deterministic-orders-v1',
  capabilities: { tools: true, streaming: false, structuredOutput: false, jsonMode: false, toolChoice: true, parallelToolCalls: false },
  async generate(input: any) {
    const results = input.messages.flatMap((m: any) => m.parts).filter((p: any) => p.type === 'tool-result').map((p: any) => p.toolResult);
    const decision = decide(results, config, caseId);
    const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
    if (decision.text !== undefined) {
      const text = decision.text;
      return { messages: [createTextMessage('assistant', text)], text, finishReason: 'stop', usage };
    }
    const {name, args} = decision;
    return { messages: [{ role: 'assistant', parts: [{ type: 'tool-call', toolCall: { id: `${caseId}-${name}`, name, input: args } }] }], finishReason: 'tool-calls', usage };
  }
};
const agent = createAgent({ id: 'orders-v1', store, model, policy: {leaseTtlMs:2000,heartbeatMs:500}, maxSteps: 8, tools: {
  read_order: tool({ name: 'read_order', schema: z.object({ order_id: z.string() }), execute: async () => request('GET') }),
  apply_change: tool({ name: 'apply_change', schema: z.object({ operation_id: z.string(), order_id: z.string(), expected_version: z.number(), target_status: z.string() }), requiresApproval: true, approvalMode: 'interrupt', approvalVersion: 'v1', execute: async (args) => request('POST', args) })
} as any });
const controlFile = join(directory, 'control.json');
let waiting: any;
if (mode === 'start') {
  const result = await runAgent(agent, { prompt: `Read order ${config.order_id}, then request change to ${config.target_status}. Wait for approval. Report only the tool result.` });
  waiting = { runId: result.state.runId, approval: result.state.pendingApprovals[0], state: result.state };
  if (result.status !== 'waiting_approval' || !waiting.approval) throw new Error(`Expected approval: ${result.status}`);
  await writeFile(controlFile, JSON.stringify(waiting));
} else waiting = JSON.parse(await readFile(controlFile, 'utf8'));
const persisted = normalizeAgentRunState(await store.load(waiting.runId));
emit({ event: 'ready', status: persisted.status, runId: persisted.runId, pending: persisted.pendingApprovals.length, output: persisted.outputText, appliedResults: persisted.toolResults.filter((r:any)=>r.toolName==='apply_change' && !r.isError).length, revision:persisted.revision });
if(mode==='inspect') process.exit(0);
for await (const line of createInterface({ input: process.stdin })) {
  const { command } = JSON.parse(line);
  if (command === 'exit') process.exit(0);
  const started = performance.now();
  try {
    let state = normalizeAgentRunState(await store.load(waiting.runId));
    if (command === 'reconcile') {
      const journal = (await store.listToolCalls!(waiting.runId)).find(entry => entry.toolName === 'apply_change')!;
      const output = await request('GET');
      state = await reconcileAgentToolExecution({ store, evidence: { operationId: caseId, runId: state.runId, toolCallId: journal.toolCallId, toolName: journal.toolName, idempotencyKey: journal.idempotencyKey, input: journal.input!, output, source: service, proof: { caseId } }, verifyEvidence: async evidence => {
        const confirmed = await request('GET');
        return (evidence.input as any).operation_id === caseId && confirmed.order_id === config.order_id && confirmed.version === config.version + 1 && confirmed.status === config.target_status && JSON.stringify(confirmed) === JSON.stringify(evidence.output);
      }});
    }
    const result = await resumeAgent(agent, { state, ...(['recover','reconcile'].includes(command)?{}:{approvals: [{ provider: waiting.approval.provider, approvalRequestId: waiting.approval.id, approve: command!=='deny', reason: command==='deny'?'experiment_denied':undefined }]}) });
    const stored = normalizeAgentRunState(await store.load(waiting.runId));
    emit({ event: 'result', command, status: result.status, persistedStatus: stored.status, taskOutcome: stored.taskOutcome, toolResults:stored.toolResults, pending:stored.pendingApprovals.length, output: result.outputText, usage: result.usage, elapsedMs: performance.now() - started, runId: result.state.runId });
  } catch (e: any) {
    const stored = normalizeAgentRunState(await store.load(waiting.runId));
    emit({ event: 'error', command, message: e.message, name: e.name, persistedStatus: stored.status, runId: stored.runId, output: stored.outputText });
  }
}
