import { Agent, createMockLanguageModel, createTextMessage } from "../../packages/sdk/src/index";
import {
  createDockerSandboxEnvironment,
  createDockerSandboxTools,
  createMemoryDockerClient,
  dockerSandboxSecurityDefaults
} from "../../packages/sandbox-docker/src/index";

import { section } from "../_shared";

const docker = createMemoryDockerClient();
const sandbox = createDockerSandboxEnvironment({
  docker,
  assurance: "best-effort",
  shell: { allow: ["echo"] },
  workspace: {
    id: "workspace-example",
    files: [{ path: "README.md", contents: "hello\n" }]
  }
});

const model = createMockLanguageModel({
  responses: [
    {
      finishReason: "tool-calls",
      messages: [{
        role: "assistant",
        parts: [{
          type: "tool-call",
          toolCall: {
            id: "call-write",
            name: "sandbox_write_file",
            input: { path: "note.txt", contents: "saved" }
          }
        }]
      }]
    },
    {
      text: "saved",
      finishReason: "stop",
      messages: [createTextMessage("assistant", "saved")]
    }
  ]
});

const agent = new Agent({
  id: "sandbox-example",
  model,
  maxSteps: 3,
  executionEnvironment: sandbox,
  tools: createDockerSandboxTools()
});

section("Security defaults");
console.log(JSON.stringify({
  image: dockerSandboxSecurityDefaults.image,
  user: dockerSandboxSecurityDefaults.user,
  network: dockerSandboxSecurityDefaults.network,
  shell: dockerSandboxSecurityDefaults.shell,
  localUnixFallback: dockerSandboxSecurityDefaults.localUnixFallback
}, null, 2));

section("Approval pause");
const waiting = await agent.run({ prompt: "Write note.txt" });
console.log(waiting.status);
if (waiting.status !== "waiting_approval") {
  throw new Error(`Expected waiting_approval, received ${waiting.status}.`);
}

section("Resume on the same container");
const resumed = await agent.resume({
  state: waiting.state,
  approvals: waiting.state.pendingApprovals.map(approval => ({
    provider: approval.provider,
    approvalRequestId: approval.id,
    approve: true
  }))
});
console.log(resumed.status, resumed.outputText);
if (resumed.status !== "completed" || resumed.outputText !== "saved") {
  throw new Error("Sandbox resume did not complete on the saved note.");
}
if (docker.createdContainerIds().length !== 1 || docker.containerIds().length !== 0) {
  throw new Error("The paused run did not reattach and then release one container.");
}
