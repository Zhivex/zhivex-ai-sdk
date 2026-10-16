/**
 * Experimental A2A 1.0 round trip with a deterministic model.
 * No provider credentials. Build the workspace first, then run:
 *   bun run build && bun run examples/sdk/a2a-roundtrip.ts
 */
import {
  createAgent,
  createInMemorySessionService,
  createTextMessage,
  runAgent,
  type LanguageModel,
  type StreamEvent
} from "../../packages/sdk/src/index";
import {
  createA2aAgentServer,
  createRemoteA2aAgent,
  createRemoteA2aAgentTool
} from "../../packages/sdk/src/a2a";

import { section } from "../_shared";

const capabilities: LanguageModel["capabilities"] = {
  streaming: true,
  tools: true,
  structuredOutput: false,
  jsonMode: false,
  toolChoice: true,
  parallelToolCalls: false,
  vision: false,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
  reasoning: false,
  webSearch: false
};

const model: LanguageModel = {
  provider: "test",
  modelId: "a2a-example",
  capabilities,
  async generate() {
    return {
      messages: [createTextMessage("assistant", "pong")],
      text: "pong",
      finishReason: "stop"
    };
  },
  async stream() {
    return (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "text-delta", textDelta: "pong" };
      yield { type: "finish", finishReason: "stop" };
    })();
  }
};

const server = await createA2aAgentServer({
  appName: "a2a-example",
  userId: "user_1",
  agent: createAgent({ model, maxSteps: 1 }),
  sessionService: createInMemorySessionService(),
  card: { name: "Echo", description: "Returns pong.", version: "0.0.0-experimental" }
});

try {
  section("Agent Card");
  const card = await fetch(server.cardUrl).then((response) => response.json());
  console.log(card.name, card.supportedInterfaces[0].protocolVersion);

  section("Remote client");
  const remote = createRemoteA2aAgent({ url: server.cardUrl, allowLoopbackHttp: true });
  const task = await remote.send({ text: "ping", messageId: "msg_example" });
  console.log(task.status.state, task.artifacts?.[0]?.parts[0]?.text);

  section("Parent tool");
  let calls = 0;
  const parent = createAgent({
    model: {
      ...model,
      async generate() {
        calls += 1;
        if (calls === 1) {
          return {
            messages: [{
              role: "assistant",
              parts: [{
                type: "tool-call",
                toolCall: { id: "call_1", name: "echo_agent", input: { prompt: "ping" } }
              }]
            }],
            finishReason: "tool-calls"
          };
        }
        return {
          messages: [createTextMessage("assistant", "delegated")],
          text: "delegated",
          finishReason: "stop"
        };
      }
    },
    maxSteps: 3,
    tools: {
      echo_agent: createRemoteA2aAgentTool({
        name: "echo_agent",
        agent: { url: server.cardUrl, allowLoopbackHttp: true }
      })
    }
  });
  const result = await runAgent(parent, { prompt: "Delegate." });
  console.log(result.status, result.outputText);
} finally {
  await server.close();
}
