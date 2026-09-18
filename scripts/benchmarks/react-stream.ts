import { chatReducer, createInitialChatState } from "../../packages/react/src/reducer.ts";
import type { ChatMessage, ChatStreamChunk } from "../../packages/react/src/types.ts";
const messages: ChatMessage[] = Array.from({ length: 1000 }, (_, index) => ({
  id: `history-${index}`, role: "assistant", parts: [{ type: "text", text: "History" }], status: "complete", createdAt: index
}));
const chunks: ChatStreamChunk[] = Array.from({ length: 5000 }, (_, index) => ({
  type: "text-delta", messageId: "active", role: "assistant", textDelta: String(index % 10),
  replay: { streamId: "benchmark", sequence: index + 1 }
}));
const measure = (batched: boolean) => {
  let state = createInitialChatState({ messages });
  const start = performance.now();
  if (batched) {
    for (let i = 0; i < chunks.length; i += 50) state = chatReducer(state, { type: "stream-chunks", chunks: chunks.slice(i, i + 50), now: 1 });
  } else {
    for (const chunk of chunks) state = chatReducer(state, { type: "stream-chunk", chunk, now: 1 });
  }
  const ms = performance.now() - start;
  return { ms, output: state.messages.at(-1)?.parts, messages: state.messages.length };
};
measure(false); measure(true);
const baseline = measure(false);
const batched = measure(true);
if (JSON.stringify(baseline.output) !== JSON.stringify(batched.output)) throw new Error("Batch output changed.");
console.log(JSON.stringify({ history: messages.length, chunks: chunks.length, baselineMs: baseline.ms,
  batchedMs: batched.ms, speedup: baseline.ms / batched.ms, outputsEqual: true }, null, 2));
