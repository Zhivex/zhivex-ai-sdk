import { spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";

const mode = process.env.MCP_FIXTURE_MODE ?? "ok";
const send = (message) => {
  fs.writeSync(1, `${JSON.stringify(message)}\n`);
};

fs.writeSync(2, `stderr-secret pid:${process.pid}\n`);

if (mode === "ignore-shutdown" || mode === "grandchild") {
  process.stdin.resume();
  process.on("SIGTERM", () => {
    fs.writeSync(2, "got-term\n");
  });
  setInterval(() => undefined, 1_000);
}

if (mode === "grandchild") {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore"
  });
  fs.writeSync(2, `grandchild:${grandchild.pid}\n`);
}

const capabilities = mode === "tools-only"
  ? { tools: {} }
  : { tools: {}, resources: {}, prompts: {} };

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === 9001 && message.result) {
    fs.writeSync(2, "pong\n");
    return;
  }
  if (message.id === 9002 && message.error) {
    fs.writeSync(2, "method-not-found\n");
    return;
  }
  if (message.method === "notifications/cancelled") {
    fs.writeSync(2, `cancelled:${message.params?.requestId}\n`);
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "initialize") {
    if (mode === "bad-version") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { protocolVersion: "1999-01-01", capabilities, serverInfo: { name: "fixture", version: "1" } }
      });
      return;
    }
    const opened = [{
      jsonrpc: "2.0",
      id: message.id,
      result: { protocolVersion: "2025-11-25", capabilities, serverInfo: { name: "fixture", version: "1" } }
    }];
    if (mode === "ping") opened.push({ jsonrpc: "2.0", id: 9001, method: "ping" });
    if (mode === "server-request") opened.push({ jsonrpc: "2.0", id: 9002, method: "sampling/createMessage", params: {} });
    fs.writeSync(1, opened.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    return;
  }
  if (mode === "delay-call" && message.method === "tools/call") {
    setTimeout(() => send({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: "late" }], isError: false }
    }), 300);
    return;
  }
  if (mode === "crash-on-call" && message.method === "tools/call") {
    fs.writeSync(2, "crash-secret\n");
    process.exit(1);
  }
  if (mode === "crash-on-list" && message.method === "tools/list") process.exit(1);
  if (mode === "slow" && message.method === "tools/list") {
    setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }), 5_000);
    return;
  }
  if (mode === "huge" && message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [], padding: "x".repeat(50_000) } });
    return;
  }
  if (mode === "bad-json") {
    fs.writeSync(1, "{not-json\n");
    return;
  }
  if (mode === "bad-utf8") {
    fs.writeSync(1, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("\n")]));
    return;
  }
  if (mode === "rpc-error") {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "secret-server-error" } });
    return;
  }
  if (mode === "bad-tool-result" && message.method === "tools/call") {
    send({ jsonrpc: "2.0", id: message.id, result: { unexpected: true } });
    return;
  }
  if (mode === "split" && message.method === "tools/list") {
    const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "split", inputSchema: { type: "object" } }] } });
    fs.writeSync(1, body.slice(0, 8));
    fs.writeSync(1, `${body.slice(8)}\n`);
    return;
  }
  if (message.method === "tools/list") {
    const parentOnly = process.env.MCP_PARENT_ONLY ?? "missing";
    const visible = process.env.MCP_VISIBLE ?? "missing";
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "get-bcra-fx-quotes",
            description: `fx argv:${process.argv.slice(2).join(",")}`,
            inputSchema: { type: "object", properties: { fecha: { type: "string" } } },
            annotations: { readOnlyHint: true, openWorldHint: true }
          },
          {
            name: "get-bcra-variables",
            description: "variables",
            inputSchema: { type: "object", properties: {} }
          },
          {
            name: "get-bcra-entities",
            description: "entities",
            inputSchema: { type: "object", properties: {} }
          },
          {
            name: "get-bcra-client-central-deudores",
            description: "debtor lookup",
            inputSchema: { type: "object", properties: { clientId: { type: "string" } } }
          },
          {
            name: "env-probe",
            description: `parent:${parentOnly};visible:${visible}`,
            inputSchema: { type: "object", properties: {} }
          }
        ]
      }
    });
    return;
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    if (mode === "reorder") {
      const respond = () => send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: String(name) }], isError: false }
      });
      if (name === "first") setTimeout(respond, 40);
      else respond();
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: JSON.stringify({ tool: name, arguments: message.params?.arguments ?? null }) }],
        isError: false
      }
    });
    return;
  }
  if (message.method === "resources/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { resources: [{ uri: "bcra://variables", name: "variables" }], nextCursor: "next" } });
    return;
  }
  if (message.method === "resources/templates/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { resourceTemplates: [{ uriTemplate: "bcra://variables/{id}", name: "variable" }] } });
    return;
  }
  if (message.method === "resources/read") {
    send({ jsonrpc: "2.0", id: message.id, result: { contents: [{ uri: message.params?.uri, text: "reservas" }] } });
    return;
  }
  if (message.method === "prompts/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { prompts: [{ name: "summarize", arguments: [{ name: "topic", required: false }] }] } });
    return;
  }
  if (message.method === "prompts/get") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { description: "summary", messages: [{ role: "user", content: { type: "text", text: "Summarize variables." } }] }
    });
  }
});
