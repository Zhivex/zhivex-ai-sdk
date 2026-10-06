import assert from 'node:assert/strict';
import { generateText } from '@zhivex-ai/sdk';
import { runComputerUse, ComputerUseExecutionError } from '@zhivex-ai/sdk/experimental';
import { createOpenAI, openAIComputerTool, OpenAIComputerExecutionError } from '@zhivex-ai/openai';

const image = 'data:image/png;base64,aGVsbG8=';
const screenshot = { type: 'computer_screenshot', image_url: image };
const check = { id: 'safety_fixture', code: 'untrusted', message: 'Confirm this synthetic action' };
let requests = [], executions = 0;
const model = createOpenAI({ apiKey: 'fixture', fetch: async (_url, init) => {
  requests.push(JSON.parse(init.body));
  return Response.json({ id: `resp_${requests.length}`, status: 'completed', output: requests.length === 1
    ? [{ type: 'computer_call', call_id: 'call_fixture', actions: [{ type: 'screenshot' }], pending_safety_checks: [check] }]
    : [{ type: 'message', content: [{ type: 'output_text', text: 'observed' }] }] });
} })('gpt-6-luna');
await generateText({ model, prompt: 'synthetic', maxSteps: 2, toolApprovalPolicy: () => true, tools: { computer: openAIComputerTool({
  approveSafetyChecks: (input, context) => {
    assert.deepEqual(input.pending_safety_checks, [check]);
    assert.equal(context.toolCall.id, input.call_id);
    assert.ok(Object.isFrozen(input.actions));
    return true;
  }, execute: () => { executions++; return screenshot; }
}) } });
assert.equal(executions, 1);
assert.deepEqual(requests[1].input, [{ type: 'computer_call_output', call_id: 'call_fixture', acknowledged_safety_checks: [check], output: { ...screenshot, detail: 'original' } }]);
requests = []; executions = 0;
await assert.rejects(generateText({ model, prompt: 'synthetic', maxSteps: 2, toolApprovalPolicy: () => true, tools: { computer: openAIComputerTool({
  approveSafetyChecks: () => false, execute: () => { executions++; return screenshot; }
}) } }));
assert.equal(executions, 0);

const reusedComputer = openAIComputerTool({ approveSafetyChecks: () => true, execute: () => { executions++; return screenshot; } });
executions = 0;
for (let invocation = 0; invocation < 3; invocation++) {
  requests = [];
  await generateText({ model, prompt: 'synthetic', maxSteps: 2, toolApprovalPolicy: () => true, tools: { computer: reusedComputer } });
}
assert.equal(executions, 3);

const textModel = { provider: 'fixture', modelId: 'offline', capabilities: { vision: true, tools: true }, generate: async () => ({ message: { role: 'assistant', parts: [{ type: 'text', text: 'done' }] }, finishReason: 'stop' }) };
let verified = 0;
await assert.rejects(runComputerUse({ model: textModel, prompt: 'fixture', environment: { viewport: { width: 10, height: 10 }, screenshot: async () => image, execute: async () => {} }, authorize: () => true, isComplete: () => { verified++; return false; } }));
assert.equal(verified, 1);
const actionModel = { ...textModel, generate: async () => ({ message: { role: 'assistant', parts: [{ type: 'tool-call', toolCall: { id: 'portable_call', name: 'computer_action', input: { actions: [{ type: 'click', x: 1, y: 1 }] } } }] }, finishReason: 'tool-calls' }) };
await assert.rejects(runComputerUse({ model: actionModel, prompt: 'fixture', callbackTimeoutMs: 10, environment: { viewport: { width: 10, height: 10 }, screenshot: async () => image, execute: async (_actions, context) => { assert.equal(context.toolCallId, 'portable_call'); await new Promise(() => {}); } }, authorize: () => true }), error => error instanceof ComputerUseExecutionError && error.outcome === 'unknown' && error.effectsPossible);
await assert.rejects(openAIComputerTool({ callbackTimeoutMs: 10, execute: async (_input, context) => { assert.ok(context.abortSignal); await new Promise(() => {}); } }).execute({ call_id: 'direct_call', actions: [{ type: 'screenshot' }] }), error => error instanceof OpenAIComputerExecutionError && error.effectsPossible);
console.log('INSTALLED_COMPUTER_USE_SAFETY_OK');
