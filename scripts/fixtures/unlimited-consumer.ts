import { Agent, generateText, streamText, type AgentRunState, type LanguageModel } from '@zhivex-ai/sdk';
import { Agent as AgentsFacade, normalizeAgentRunState } from '@zhivex-ai/agents';
export async function unlimitedConsumer(model: LanguageModel, state: AgentRunState) {
  const options = { model, maxSteps: 'unlimited' as const, timeoutMs: 1000, prompt: 'Continue' };
  await generateText(options);
  await streamText(options).collect();
  await new Agent({ model, maxSteps: 'unlimited', policy: { budget: { maxToolCalls: 10 } } }).run(options);
  await new AgentsFacade({ model }).resume({ state: normalizeAgentRunState(state), maxSteps: 'unlimited' });
}
