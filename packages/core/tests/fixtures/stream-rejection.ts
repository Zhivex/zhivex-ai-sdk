import { streamText } from "../../src/generate-text.js";
import { ProviderHTTPError } from "../../src/errors.js";
import type { LanguageModel, StreamEvent } from "../../src/types.js";

const kind = process.argv[2];
const consumer = process.argv[3];
const error = kind === "http" ? new ProviderHTTPError("fixture", 400)
  : kind === "abort" ? new DOMException("fixture", "AbortError") : new Error("fixture");
const unhandled: unknown[] = [];
process.on("unhandledRejection", reason => unhandled.push(reason));
const controller = new AbortController();
const model: LanguageModel = {
  provider: "fixture", modelId: "fixture",
  capabilities: { streaming: true, tools: false, structuredOutput: false, jsonMode: false, toolChoice: false, parallelToolCalls: false, vision: false, files: false, audioInput: false, audioOutput: false, embeddings: false, reasoning: false, webSearch: false },
  async generate() { throw error; },
  async stream(input) {
    if (kind === "http" || kind === "network") throw error;
    return (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "text-delta", textDelta: "partial" };
      if (kind === "abort") {
        controller.abort(error);
        throw input.abortSignal!.reason;
      }
      if (kind === "error-event") yield { type: "error", error };
      else throw error;
    })();
  }
};
const result = streamText({ model, prompt: "fixture", abortSignal: controller.signal });
const events: string[] = [];
if (consumer === "text") {
  for await (const _text of result.textStream) { /* drain */ }
} else {
  for await (const event of result.eventStream) events.push(event.type);
}
// Allow Node to report unobserved rejections before attaching a late collector.
await new Promise(resolve => setTimeout(resolve, 25));
let sameError = false;
try { await result.collect(); } catch (caught) { sameError = caught === error; }
console.log(JSON.stringify({ events, unhandled: unhandled.length, sameError }));
