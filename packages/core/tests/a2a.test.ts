import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAgent,
  createFileSessionService,
  createInMemorySessionService,
  createTextMessage,
  runAgent,
  tool,
  type LanguageModel,
  type StreamEvent
} from "../src/index.js";
import {
  A2A_API_STABILITY_MANIFEST,
  A2A_JSON_RPC_ERROR,
  A2A_PROTOCOL_VERSION,
  A2A_SPEC_VERSION,
  A2aProtocolError,
  assertA2aDestination,
  createA2aAgentServer,
  createRemoteA2aAgent,
  createRemoteA2aAgentTool,
  type A2aAgentServer,
  type A2aTask
} from "../src/a2a.js";
import * as a2aNode from "../src/a2a.js";
import * as a2aBrowser from "../src/a2a-browser.js";

const execFileAsync = promisify(execFile);
const sourceRoot = path.resolve(import.meta.dirname, "../src");
const servers: A2aAgentServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const capabilities: LanguageModel["capabilities"] = {
  streaming: true,
  tools: true,
  structuredOutput: true,
  jsonMode: true,
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

const userText = (input: { messages?: Array<{ role?: string; parts?: Array<{ type?: string; text?: string }> }> }): string =>
  (input.messages ?? [])
    .filter((message) => message.role === "user")
    .flatMap((message) => message.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");

const echoModel = (): LanguageModel & { calls: number } => {
  const model = {
    provider: "test",
    modelId: "a2a-echo",
    capabilities,
    calls: 0,
    async generate(input: { messages?: Array<{ role?: string; parts?: Array<{ type?: string; text?: string }> }> }) {
      model.calls += 1;
      const prompt = userText(input);
      if (prompt.includes("please-fail")) throw new Error("provider-token-secret");
      const text = `echo:${prompt}`;
      return {
        messages: [createTextMessage("assistant", text)],
        text,
        finishReason: "stop" as const
      };
    },
    async stream(input: { messages?: Array<{ role?: string; parts?: Array<{ type?: string; text?: string }> }> }) {
      const text = `echo:${userText(input)}`;
      return (async function* (): AsyncGenerator<StreamEvent> {
        yield { type: "text-delta", textDelta: text.slice(0, 5) };
        yield { type: "text-delta", textDelta: text.slice(5) };
        yield { type: "finish", finishReason: "stop" };
      })();
    }
  };
  return model;
};

const rpc = async (
  url: string,
  method: string,
  params: unknown,
  headers: Record<string, string> = {}
) => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "a2a-version": A2A_PROTOCOL_VERSION,
      ...headers
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "rpc_1", method, params })
  });
  return { status: response.status, body: await response.json() as { result?: { task?: A2aTask } & A2aTask; error?: { code: number; message: string }; id?: string } };
};

describe("A2A destination policy", () => {
  it("rejects private, metadata, credentialed, and plain HTTP targets", async () => {
    const rejected = [
      "http://example.com/rpc",
      "https://user:pass@example.com/rpc",
      "https://example.com/rpc#fragment",
      "https://127.0.0.1/rpc",
      "https://10.1.2.3/rpc",
      "https://192.168.1.9/rpc",
      "https://169.254.169.254/latest",
      "https://metadata.google.internal/rpc",
      "not a url"
    ];
    for (const target of rejected) {
      await expect(assertA2aDestination(target)).rejects.toMatchObject({
        code: "DESTINATION_REJECTED"
      });
    }
    const loopback = await assertA2aDestination("http://127.0.0.1:9/rpc", { allowLoopbackHttp: true });
    expect(loopback.protocol).toBe("http:");
    const loopbackTls = await assertA2aDestination("https://127.0.0.1/rpc", { allowLoopbackHttp: true });
    expect(loopbackTls.hostname).toBe("127.0.0.1");
    await expect(assertA2aDestination("http://127.0.0.1:9/rpc")).rejects.toMatchObject({ code: "DESTINATION_REJECTED" });
    await expect(assertA2aDestination("http://10.1.2.3/rpc", { allowLoopbackHttp: true })).rejects.toMatchObject({
      code: "DESTINATION_REJECTED"
    });
  });

  it("asks the MCP destination policy before any fetch", async () => {
    const seen: string[] = [];
    await expect(assertA2aDestination("https://example.com/rpc", {
      destinationPolicy: (url, purpose) => {
        seen.push(`${purpose}:${url.hostname}`);
        return false;
      }
    })).rejects.toMatchObject({ code: "DESTINATION_REJECTED" });
    expect(seen).toEqual(["server:example.com"]);

    let fetched = 0;
    const agent = createRemoteA2aAgent({
      url: "http://169.254.169.254/latest",
      allowLoopbackHttp: true,
      fetch: (async () => {
        fetched += 1;
        return new Response("{}", { status: 200 });
      }) as typeof fetch
    });
    await expect(agent.card()).rejects.toBeInstanceOf(A2aProtocolError);
    expect(fetched).toBe(0);
  });
});

describe("A2A JSON-RPC server", () => {
  const start = async (maxRequestBytes = 4096) => {
    const model = echoModel();
    const server = await createA2aAgentServer({
      appName: "a2a-tests",
      userId: "user_1",
      agent: createAgent({ model, maxSteps: 2 }),
      sessionService: createInMemorySessionService(),
      card: {
        name: "Echo",
        description: "Returns the user prompt.",
        version: "1.2.3"
      },
      maxRequestBytes
    });
    servers.push(server);
    return { server, model };
  };

  it("publishes an Agent Card and completes send, get, stream, and legacy aliases", async () => {
    const { server, model } = await start();
    const cardResponse = await fetch(server.cardUrl);
    expect(cardResponse.status).toBe(200);
    expect(cardResponse.headers.get("cache-control")).toContain("no-store");
    const card = await cardResponse.json() as {
      name: string;
      version: string;
      capabilities: { streaming?: boolean };
      supportedInterfaces: Array<{ protocolBinding: string; protocolVersion: string; url: string }>;
    };
    expect(card).toMatchObject({
      name: "Echo",
      version: "1.2.3",
      capabilities: { streaming: true },
      defaultInputModes: ["text/plain", "application/json"],
      defaultOutputModes: ["text/plain", "application/json"]
    });
    expect(card.supportedInterfaces[0]).toMatchObject({
      protocolBinding: "JSONRPC",
      protocolVersion: A2A_PROTOCOL_VERSION,
      url: server.rpcUrl
    });

    const sent = await rpc(server.rpcUrl, "SendMessage", {
      message: { messageId: "msg_1", role: "ROLE_USER", parts: [{ text: "ping" }] }
    });
    expect(sent.status).toBe(200);
    expect(sent.body.result?.task?.status.state).toBe("TASK_STATE_COMPLETED");
    expect(sent.body.result?.task?.artifacts?.[0]?.parts[0]?.text).toBe("echo:ping");
    expect(sent.body.result?.task?.contextId).toMatch(/^ctx_/);
    expect(model.calls).toBe(1);

    const taskId = sent.body.result?.task?.id ?? "";
    const loaded = await rpc(server.rpcUrl, "tasks/get", { id: taskId, historyLength: 0 });
    expect(loaded.body.result?.status.state).toBe("TASK_STATE_COMPLETED");
    expect(loaded.body.result?.history).toEqual([]);

    const alias = await rpc(server.rpcUrl, "message/send", {
      message: { messageId: "msg_1", role: "ROLE_USER", parts: [{ text: "ping" }] }
    });
    expect(alias.body.result?.task?.id).toBe(taskId);
    expect(model.calls).toBe(1);

    const remote = createRemoteA2aAgent({ url: server.cardUrl, allowLoopbackHttp: true });
    const events = [];
    for await (const event of remote.stream({ text: "stream", messageId: "msg_stream" })) events.push(event);
    expect(events[0]?.task?.status.state).toBe("TASK_STATE_WORKING");
    const streamed = events.filter((event) => event.artifactUpdate).map((event) => event.artifactUpdate?.artifact.parts[0]?.text).join("");
    expect(streamed).toBe("echo:stream");
    expect(events.some((event) => event.artifactUpdate?.lastChunk === true)).toBe(true);
    expect(events.at(-1)?.statusUpdate?.status.state).toBe("TASK_STATE_COMPLETED");
    expect(await remote.getTask(events[0]?.task?.id ?? "")).toMatchObject({ status: { state: "TASK_STATE_COMPLETED" } });

    const failed = await rpc(server.rpcUrl, "SendMessage", {
      message: { messageId: "msg_fail", role: "ROLE_USER", parts: [{ text: "please-fail" }] }
    });
    expect(failed.body.result?.task?.status.state).toBe("TASK_STATE_FAILED");
    expect(JSON.stringify(failed.body)).not.toContain("provider-token-secret");
  });

  it("rejects auth, version, size, parse, method, push, and unsupported requests", async () => {
    const server = await createA2aAgentServer({
      appName: "a2a-auth",
      authenticate: (request) => request.headers.authorization === "Bearer secret" ? { userId: "user_1" } : undefined,
      agent: createAgent({ model: echoModel(), maxSteps: 1 }),
      sessionService: createInMemorySessionService(),
      card: { name: "Guarded", description: "Requires a bearer token." },
      maxRequestBytes: 320
    });
    servers.push(server);

    const denied = await rpc(server.rpcUrl, "GetTask", { id: "task_missing" });
    expect(denied.status).toBe(401);
    expect(denied.body.error?.code).toBe(A2A_JSON_RPC_ERROR.authRequired);

    const allowed = await rpc(server.rpcUrl, "GetTask", { id: "task_missing" }, { authorization: "Bearer secret" });
    expect(allowed.status).toBe(404);
    expect(allowed.body.error?.code).toBe(A2A_JSON_RPC_ERROR.taskNotFound);

    const unversioned = await fetch(server.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "GetTask", params: { id: "task_missing" } })
    });
    expect(unversioned.status).toBe(400);
    expect(await unversioned.json()).toMatchObject({ id: 7, error: { code: A2A_JSON_RPC_ERROR.version } });

    const huge = await rpc(server.rpcUrl, "SendMessage", {
      message: { messageId: "msg_huge", role: "ROLE_USER", parts: [{ text: "x".repeat(400) }] }
    }, { authorization: "Bearer secret" });
    expect(huge.body.error?.code).toBe(A2A_JSON_RPC_ERROR.limitExceeded);

    const parsed = await fetch(server.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "a2a-version": "1.0", authorization: "Bearer secret" },
      body: "{"
    });
    expect(await parsed.json()).toMatchObject({ error: { code: A2A_JSON_RPC_ERROR.parse } });

    const unknown = await rpc(server.rpcUrl, "NoSuchMethod", {}, { authorization: "Bearer secret" });
    expect(unknown.body.error?.code).toBe(A2A_JSON_RPC_ERROR.methodNotFound);
    const push = await rpc(server.rpcUrl, "CreateTaskPushNotificationConfig", {}, { authorization: "Bearer secret" });
    expect(push.body.error?.code).toBe(A2A_JSON_RPC_ERROR.pushNotSupported);
    const immediate = await rpc(server.rpcUrl, "SendMessage", {
      message: { messageId: "msg_now", role: "ROLE_USER", parts: [{ text: "hi" }] },
      configuration: { returnImmediately: true }
    }, { authorization: "Bearer secret" });
    expect(immediate.body.error?.code).toBe(A2A_JSON_RPC_ERROR.unsupported);
    const filePart = await rpc(server.rpcUrl, "SendMessage", {
      message: { messageId: "msg_file", role: "ROLE_USER", parts: [{ url: "https://example.com/a.txt" }] }
    }, { authorization: "Bearer secret" });
    expect(filePart.body.error?.code).toBe(A2A_JSON_RPC_ERROR.contentType);

    const batch = await fetch(server.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "a2a-version": "1.0", authorization: "Bearer secret" },
      body: "[]"
    });
    expect(await batch.json()).toMatchObject({ error: { code: A2A_JSON_RPC_ERROR.invalidRequest } });
    expect(A2A_SPEC_VERSION).toBe("1.0.0");
  });

  it("pauses for approval, hides tool arguments, and resumes the same task", async () => {
    let executions = 0;
    const agent = createAgent({
      model: {
        provider: "test",
        modelId: "approval",
        capabilities,
        async generate() {
          executions += 1;
          if (executions === 1) {
            return {
              messages: [{
                role: "assistant" as const,
                parts: [{ type: "tool-call" as const, toolCall: { id: "call_1", name: "deploy", input: { secret: "do-not-leak" } } }]
              }],
              finishReason: "tool-calls" as const
            };
          }
          return {
            messages: [createTextMessage("assistant", "deployed")],
            text: "deployed",
            finishReason: "stop" as const
          };
        }
      },
      tools: {
        deploy: tool({
          name: "deploy",
          schema: z.object({ secret: z.string() }),
          requiresApproval: true,
          approvalMode: "interrupt",
          execute: () => "done"
        })
      },
      maxSteps: 3
    });
    const server = await createA2aAgentServer({
      appName: "a2a-approvals",
      userId: "user_1",
      agent,
      sessionService: createInMemorySessionService(),
      card: { name: "Approver", description: "Waits for a local tool approval." }
    });
    servers.push(server);
    const waiting = await rpc(server.rpcUrl, "SendMessage", {
      message: { messageId: "msg_wait", role: "ROLE_USER", parts: [{ text: "deploy" }] }
    });
    const task = waiting.body.result?.task;
    expect(task?.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
    expect(JSON.stringify(task)).not.toContain("do-not-leak");
    const data = task?.status.message?.parts.find((part) => part.data)?.data as { approvals?: Array<{ approvalRequestId: string }> };
    const approvalRequestId = data.approvals?.[0]?.approvalRequestId ?? "";
    expect(approvalRequestId.length).toBeGreaterThan(0);

    const open = await rpc(server.rpcUrl, "SendMessage", {
      message: { messageId: "msg_other", role: "ROLE_USER", contextId: task?.contextId, parts: [{ text: "again" }] }
    });
    expect(open.body.error?.code).toBe(A2A_JSON_RPC_ERROR.unsupported);

    const resumed = await rpc(server.rpcUrl, "SendMessage", {
      message: {
        messageId: "msg_resume",
        role: "ROLE_USER",
        contextId: task?.contextId,
        taskId: task?.id,
        parts: [{ data: { approvals: [{ approvalRequestId, approve: true }] } }]
      }
    });
    expect(resumed.body.result?.task?.status.state).toBe("TASK_STATE_COMPLETED");
    expect(resumed.body.result?.task?.artifacts?.[0]?.parts[0]?.text).toBe("deployed");

    const terminal = await rpc(server.rpcUrl, "SendMessage", {
      message: {
        messageId: "msg_after",
        role: "ROLE_USER",
        taskId: task?.id,
        parts: [{ text: "more" }]
      }
    });
    expect(terminal.body.error?.message).toBe("The task is already in a terminal state.");
    const canceled = await rpc(server.rpcUrl, "tasks/cancel", { id: task?.id });
    expect(canceled.body.error?.code).toBe(A2A_JSON_RPC_ERROR.taskNotCancelable);
  });

  it("cancels an in-flight streamed task", async () => {
    const server = await createA2aAgentServer({
      appName: "a2a-cancel",
      userId: "user_1",
      agent: createAgent({
        model: {
          provider: "test",
          modelId: "cancel",
          capabilities,
          async generate(input) {
            await new Promise((_resolve, reject) => {
              const signal = input.abortSignal;
              if (!signal) {
                reject(new Error("missing abort signal"));
                return;
              }
              if (signal.aborted) {
                reject(new Error("aborted"));
                return;
              }
              signal.addEventListener("abort", () => reject(new Error("aborted-secret")), { once: true });
            });
            return { messages: [createTextMessage("assistant", "late")], text: "late", finishReason: "stop" as const };
          },
          async stream(input) {
            await new Promise((_resolve, reject) => {
              const signal = input.abortSignal;
              if (!signal) {
                reject(new Error("missing abort signal"));
                return;
              }
              signal.addEventListener("abort", () => reject(new Error("aborted-secret")), { once: true });
            });
            return (async function* (): AsyncGenerator<StreamEvent> {
              yield { type: "finish", finishReason: "stop" };
            })();
          }
        },
        maxSteps: 1
      }),
      sessionService: createInMemorySessionService(),
      card: { name: "Cancelable", description: "Can be canceled." }
    });
    servers.push(server);
    const remote = createRemoteA2aAgent({ url: server.cardUrl, allowLoopbackHttp: true });
    const iterator = remote.stream({ text: "wait", messageId: "msg_slow" });
    const first = await iterator.next();
    expect(first.value?.task?.status.state).toBe("TASK_STATE_WORKING");
    const taskId = first.value?.task?.id ?? "";
    const canceled = await remote.cancelTask(taskId);
    expect(canceled.status.state).toBe("TASK_STATE_CANCELED");
    const rest = [];
    for await (const event of iterator) rest.push(event);
    expect(JSON.stringify(rest)).not.toContain("aborted-secret");
    expect(rest.at(-1)?.statusUpdate?.status.state).toBe("TASK_STATE_CANCELED");
    expect(await remote.getTask(taskId)).toMatchObject({ status: { state: "TASK_STATE_CANCELED" } });
    const again = await remote.cancelTask(taskId);
    expect(again.status.state).toBe("TASK_STATE_CANCELED");
  });

  it("resumes an approval after the file-backed session service is reopened", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zhivex-a2a-"));
    try {
      let executions = 0;
      const agent = () => createAgent({
        model: {
          provider: "test",
          modelId: "durable",
          capabilities,
          async generate() {
            executions += 1;
            if (executions === 1) {
              return {
                messages: [{
                  role: "assistant" as const,
                  parts: [{ type: "tool-call" as const, toolCall: { id: "call_1", name: "deploy", input: { secret: "do-not-leak" } } }]
                }],
                finishReason: "tool-calls" as const
              };
            }
            return {
              messages: [createTextMessage("assistant", "resumed")],
              text: "resumed",
              finishReason: "stop" as const
            };
          }
        },
        tools: {
          deploy: tool({
            name: "deploy",
            schema: z.object({ secret: z.string() }),
            requiresApproval: true,
            approvalMode: "interrupt",
            execute: () => "done"
          })
        },
        maxSteps: 3
      });
      const first = await createA2aAgentServer({
        appName: "a2a-durable",
        userId: "user_1",
        agent: agent(),
        sessionService: createFileSessionService({ directory }),
        card: { name: "Durable", description: "Keeps tasks in the session service." }
      });
      const waiting = await rpc(first.rpcUrl, "SendMessage", {
        message: { messageId: "msg_wait", role: "ROLE_USER", parts: [{ text: "deploy" }] }
      });
      const task = waiting.body.result?.task;
      expect(task?.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
      const approvalRequestId = ((task?.status.message?.parts.find((part) => part.data)?.data as { approvals?: Array<{ approvalRequestId: string }> }).approvals ?? [])[0]?.approvalRequestId;
      await first.close();

      const second = await createA2aAgentServer({
        appName: "a2a-durable",
        userId: "user_1",
        agent: agent(),
        sessionService: createFileSessionService({ directory }),
        card: { name: "Durable", description: "Keeps tasks in the session service." }
      });
      servers.push(second);
      const loaded = await rpc(second.rpcUrl, "GetTask", { id: task?.id });
      expect(loaded.body.result?.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
      const resumed = await rpc(second.rpcUrl, "SendMessage", {
        message: {
          messageId: "msg_resume",
          role: "ROLE_USER",
          contextId: task?.contextId,
          taskId: task?.id,
          parts: [{ data: { approvals: [{ approvalRequestId, approve: true }] } }]
        }
      });
      expect(resumed.body.result?.task?.status.state).toBe("TASK_STATE_COMPLETED");
      expect(resumed.body.result?.task?.artifacts?.[0]?.parts[0]?.text).toBe("resumed");
      expect(JSON.stringify(resumed.body)).not.toContain("do-not-leak");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("lets a parent agent call the remote agent as a tool", async () => {
    const remoteServer = await createA2aAgentServer({
      appName: "a2a-remote",
      userId: "user_1",
      agent: createAgent({ model: echoModel(), maxSteps: 1 }),
      sessionService: createInMemorySessionService(),
      card: { name: "Remote", description: "Echoes a delegated prompt." }
    });
    servers.push(remoteServer);
    let parentCalls = 0;
    const parent = createAgent({
      model: {
        provider: "test",
        modelId: "parent",
        capabilities,
        async generate() {
          parentCalls += 1;
          if (parentCalls === 1) {
            return {
              messages: [{
                role: "assistant" as const,
                parts: [{
                  type: "tool-call" as const,
                  toolCall: { id: "call_remote", name: "remote_a2a_agent", input: { prompt: "ping" } }
                }]
              }],
              finishReason: "tool-calls" as const
            };
          }
          return {
            messages: [createTextMessage("assistant", "delegated")],
            text: "delegated",
            finishReason: "stop" as const
          };
        }
      },
      tools: {
        remote_a2a_agent: createRemoteA2aAgentTool({
          name: "remote_a2a_agent",
          agent: { url: remoteServer.cardUrl, allowLoopbackHttp: true }
        })
      },
      maxSteps: 3
    });
    const result = await runAgent(parent, { prompt: "Ask the remote agent." });
    expect(result.status).toBe("completed");
    expect(result.outputText).toBe("delegated");
    expect(result.toolResults[0]?.output).toMatchObject({ state: "TASK_STATE_COMPLETED", text: "echo:ping" });
  });
});

describe("A2A entrypoints", () => {
  it("classifies every runtime export and keeps the server off browser bundles", async () => {
    expect(A2A_PROTOCOL_VERSION).toBe("1.0");
    expect(Object.keys(A2A_API_STABILITY_MANIFEST).sort()).toEqual(Object.keys(a2aNode).sort());
    expect(Object.keys(a2aBrowser).sort()).toEqual(Object.keys(a2aNode).sort());
    expect(Object.isFrozen(A2A_API_STABILITY_MANIFEST)).toBe(true);
    for (const level of Object.values(A2A_API_STABILITY_MANIFEST)) expect(level).toBe("experimental");
    expect(() => a2aBrowser.createA2aAgentServer()).toThrow(A2aProtocolError);
    for (const entry of ["index.ts", "experimental-entry.ts", "node.ts", "beta-entry.ts", "runtime-entry.ts"]) {
      const source = await readFile(path.join(sourceRoot, entry), "utf8");
      expect(source, entry).not.toContain("a2a");
    }
    const directory = await mkdtemp(path.join(os.tmpdir(), "zhivex-a2a-browser-"));
    try {
      const browserOut = path.join(directory, "browser.js");
      await execFileAsync("bun", ["build", path.join(sourceRoot, "a2a-browser.ts"), "--target=browser", `--outfile=${browserOut}`]);
      const bundled = await readFile(browserOut, "utf8");
      expect(bundled).not.toContain("node:http");
      expect(bundled).not.toContain("node:fs");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
