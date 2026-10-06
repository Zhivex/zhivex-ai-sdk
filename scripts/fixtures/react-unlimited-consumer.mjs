import assert from 'node:assert/strict';
import { applyUIMessageChunk, createInitialChatState } from '@zhivex-ai/react';
let state = applyUIMessageChunk(createInitialChatState(), { type: 'agent-run-start', currentStep: 0, maxSteps: 'unlimited' });
assert.equal(state.activity[0].maxSteps, 'unlimited');
state = applyUIMessageChunk(state, { type: 'agent-run-update', run: { runId: 'installed', currentStep: 12, maxSteps: 'unlimited', status: 'running' } });
assert.equal(state.runs[0].maxSteps, 'unlimited');
console.log('Installed React unlimited lifecycle passed.');
