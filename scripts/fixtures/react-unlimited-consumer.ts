import { applyUIMessageChunk, createInitialChatState, type ChatActivity } from '@zhivex-ai/react';
export const activity: ChatActivity = { type: 'run-start', currentStep: 0, maxSteps: 'unlimited' };
export const state = applyUIMessageChunk(createInitialChatState(), { type: 'agent-run-start', currentStep: 0, maxSteps: 'unlimited' });
