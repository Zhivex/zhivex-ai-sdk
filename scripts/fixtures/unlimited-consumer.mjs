import assert from 'node:assert/strict';
import { Agent, createMockLanguageModel, generateText, streamText } from '@zhivex-ai/sdk';
import { normalizeAgentRunState } from '@zhivex-ai/agents';
const model = createMockLanguageModel({ responses: [{ text: 'done', finishReason: 'stop' }, { text: 'done', finishReason: 'stop' }], streamEvents: [[{ type: 'text-delta', textDelta: 'done' }, { type: 'finish', finishReason: 'stop' }]] });
assert.equal((await generateText({ model, prompt: 'test', maxSteps: 'unlimited' })).text, 'done');
assert.equal((await streamText({ model, prompt: 'test', maxSteps: 'unlimited' }).collect()).text, 'done');
const output = await new Agent({ model, maxSteps: 'unlimited' }).run({ prompt: 'test' });
assert.equal(normalizeAgentRunState(JSON.parse(JSON.stringify(output.state))).maxSteps, 'unlimited');
console.log('Installed unlimited-step contract passed.');
